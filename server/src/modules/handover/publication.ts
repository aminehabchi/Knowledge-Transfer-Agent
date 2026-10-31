import type { Db } from "../../db/database.ts";
import { PermanentError } from "../../lib/errors.ts";
import { iso, type Clock } from "../../lib/util.ts";
import type { AuditLog } from "../audit/audit.ts";
import type { Job, JobQueue } from "../jobs/queue.ts";
import { IntegrationError, type DocumentRepository } from "../sharepoint/types.ts";
import { renderHandoverMarkdown } from "./render.ts";
import { HandoverContent } from "./schema.ts";

export const INGEST_JOB = "retrieval.ingest_project";

/**
 * Job handler: publishes an approved handover version to SharePoint, then queues re-indexing.
 * Idempotent: a synced publication is a no-op, and the upload path is deterministic.
 */
export function createPublishHandler(deps: { db: Db; repo: DocumentRepository; jobs: JobQueue; clock: Clock; audit: AuditLog }) {
  const { db, repo, jobs, clock, audit } = deps;
  return async (job: Job) => {
    const { handoverId, version } = job.payload as { handoverId: string; version: number };
    const pub = db.prepare("SELECT * FROM handover_publications WHERE handover_id = ? AND version = ?").get(handoverId, version);
    if (!pub) throw new PermanentError("publication record missing");
    if (pub.status === "synced") return;

    const h = db
      .prepare(
        `SELECT h.*, p.code, p.name, p.client_name, v.content_json AS approved_content, v.decided_at,
                o.display_name AS outgoing_name, m.display_name AS approver_name
         FROM handovers h JOIN projects p ON p.id = h.project_id
         JOIN handover_versions v ON v.handover_id = h.id AND v.version = ?
         JOIN users o ON o.id = h.outgoing_user_id
         LEFT JOIN users m ON m.id = v.decided_by
         WHERE h.id = ?`,
      )
      .get(version, handoverId);
    if (!h) throw new PermanentError("handover version missing");

    const content = HandoverContent.parse(JSON.parse(String(h.approved_content)));
    const markdown = renderHandoverMarkdown(content, {
      projectCode: String(h.code),
      projectName: String(h.name),
      clientName: String(h.client_name),
      version,
      outgoing: String(h.outgoing_name),
      approvedBy: String(h.approver_name ?? "unknown"),
      approvedAt: String(h.decided_at ?? ""),
    });
    const fileName = `${h.code}-handover-v${version}.md`;
    const now = () => iso(clock.now());

    try {
      const result = await repo.upload({
        projectCode: String(h.code),
        folder: "handover",
        fileName,
        content: new TextEncoder().encode(markdown),
        contentType: "text/markdown",
        metadata: {
          KtaProjectCode: String(h.code),
          KtaDocType: "Handover",
          KtaApprovalStatus: "Approved",
          KtaVersion: version,
          KtaApprovedAt: String(h.decided_at ?? ""),
          KtaApprovedBy: String(h.approver_name ?? ""),
        },
      });
      db.prepare(
        `UPDATE handover_publications SET status = 'synced', adapter_mode = ?, remote_item_id = ?, remote_path = ?, web_url = ?, etag = ?,
           metadata_status = ?, attempts = attempts + 1, last_error = ?, synced_at = ?, updated_at = ? WHERE handover_id = ? AND version = ?`,
      ).run(repo.mode, result.item.id, result.item.path, result.item.webUrl, result.item.eTag, result.metadataStatus,
        result.metadataError ?? null, now(), now(), handoverId, version);
      audit.record({ actorId: null, action: "sharepoint.publish", entityType: "handover", entityId: handoverId, projectId: String(h.project_id), details: { version, mode: repo.mode, itemId: result.item.id, metadataStatus: result.metadataStatus } });
      jobs.enqueue(INGEST_JOB, { projectId: String(h.project_id) }, { dedupeKey: `ingest:${h.project_id}` });
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      const retryable = err instanceof IntegrationError ? err.retryable : true;
      const final = !retryable || job.attempts >= job.maxAttempts;
      db.prepare("UPDATE handover_publications SET status = ?, attempts = attempts + 1, last_error = ?, updated_at = ? WHERE handover_id = ? AND version = ?")
        .run(final ? "failed" : "pending", message.slice(0, 1000), now(), handoverId, version);
      if (final) {
        audit.record({ actorId: null, action: "sharepoint.publish", entityType: "handover", entityId: handoverId, projectId: String(h.project_id), outcome: "failure", details: { version, mode: repo.mode, error: message.slice(0, 300) } });
        throw new PermanentError(message);
      }
      throw err;
    }
  };
}
