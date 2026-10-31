import { transaction, type Db } from "../../db/database.ts";
import { addMs, iso, newId, type Clock } from "../../lib/util.ts";
import type { Provenance } from "../handover/schema.ts";
import type { Principal } from "../identity/users.ts";
import { FOLDERS, type DocumentRepository, type RemoteItem } from "../sharepoint/types.ts";
import { chunkText, extractText, ftsQuery, isSupported, queryTerms, screenForInjection } from "./text.ts";

export type DocType = "handover" | "project_document" | "onboarding" | "report" | "other";

const DOC_TYPE_BY_FOLDER: Record<string, DocType> = {
  [FOLDERS.handover]: "handover",
  [FOLDERS.projectDocuments]: "project_document",
  [FOLDERS.onboarding]: "onboarding",
  [FOLDERS.reports]: "report",
};

export interface Passage {
  chunkId: string;
  documentId: string;
  documentName: string;
  docType: DocType;
  webUrl: string;
  versionLabel: string | null;
  lastModifiedAt: string | null;
  heading: string;
  text: string;
  provenance: Provenance | null;
  flagged: boolean;
  flagReason: string | null;
  stale: boolean;
  score: number;
}

export interface IngestReport {
  indexed: number;
  unchanged: number;
  unsupported: number;
  failed: number;
  removed: number;
}

const HANDOVER_VERSION = /-handover-v(\d+)\.md$/i;

/**
 * Pulls a project's documents from the DocumentRepository (SharePoint), extracts and chunks them,
 * and maintains the FTS index. Document ACLs are refreshed on every run, even when content is unchanged.
 */
export class IndexService {
  private readonly db: Db;
  private readonly repo: DocumentRepository;
  private readonly clock: Clock;
  private readonly staleAfterDays: number;

  constructor(db: Db, repo: DocumentRepository, clock: Clock, staleAfterDays: number) {
    this.db = db;
    this.repo = repo;
    this.clock = clock;
    this.staleAfterDays = staleAfterDays;
  }

  async ingestProject(projectId: string): Promise<IngestReport> {
    const project = this.db.prepare("SELECT code FROM projects WHERE id = ?").get(projectId);
    if (!project) throw new Error("project not found");
    const items = await this.repo.listProjectItems(String(project.code));
    const report: IngestReport = { indexed: 0, unchanged: 0, unsupported: 0, failed: 0, removed: 0 };

    const latestHandover = Math.max(0, ...items.map((i) => Number(HANDOVER_VERSION.exec(i.name)?.[1] ?? 0)));

    for (const item of items) {
      const acl = await this.repo.getAcl(item.id);
      const docType = DOC_TYPE_BY_FOLDER[item.folder] ?? "other";
      const hv = HANDOVER_VERSION.exec(item.name);
      const superseded = docType === "handover" && hv !== null && Number(hv[1]) < latestHandover;
      const existing = this.db.prepare("SELECT id, etag FROM documents WHERE adapter_mode = ? AND remote_item_id = ?").get(this.repo.mode, item.id);

      if (existing && existing.etag === item.eTag) {
        this.db
          .prepare("UPDATE documents SET acl_json = ?, superseded = ?, web_url = ? WHERE id = ?")
          .run(acl ? JSON.stringify(acl) : null, superseded ? 1 : 0, item.webUrl, String(existing.id));
        report.unchanged++;
        continue;
      }
      const docId = existing ? String(existing.id) : newId();
      try {
        if (!isSupported(item.name)) {
          this.upsertDocument(docId, projectId, item, docType, acl, superseded, "unsupported_format", "Format not supported for indexing yet", []);
          report.unsupported++;
          continue;
        }
        const text = extractText(item.name, await this.repo.download(item.id));
        const chunks = chunkText(text, { defaultProvenance: docType === "handover" ? "reported" : null });
        this.upsertDocument(docId, projectId, item, docType, acl, superseded, "indexed", null, chunks);
        report.indexed++;
      } catch (err) {
        this.upsertDocument(docId, projectId, item, docType, acl, superseded, "error", err instanceof Error ? err.message.slice(0, 500) : "error", []);
        report.failed++;
      }
    }

    // Documents deleted from SharePoint must disappear from the index.
    const remoteIds = new Set(items.map((i) => i.id));
    const local = this.db.prepare("SELECT id, remote_item_id FROM documents WHERE project_id = ? AND adapter_mode = ?").all(projectId, this.repo.mode);
    for (const d of local) {
      if (!remoteIds.has(String(d.remote_item_id))) {
        this.deleteDocument(String(d.id));
        report.removed++;
      }
    }
    return report;
  }

  private upsertDocument(
    id: string,
    projectId: string,
    item: RemoteItem,
    docType: DocType,
    acl: string[] | null,
    superseded: boolean,
    status: "indexed" | "unsupported_format" | "error",
    error: string | null,
    chunks: ReturnType<typeof chunkText>,
  ) {
    transaction(this.db, () => {
      this.deleteChunks(id);
      let flagged = 0;
      this.db
        .prepare(
          `INSERT INTO documents (id, project_id, adapter_mode, remote_item_id, name, folder, doc_type, web_url, etag, version_label,
             last_modified_at, acl_json, superseded, ingest_status, ingest_error, flagged_chunks, indexed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, folder = excluded.folder, doc_type = excluded.doc_type, web_url = excluded.web_url,
             etag = excluded.etag, version_label = excluded.version_label, last_modified_at = excluded.last_modified_at, acl_json = excluded.acl_json,
             superseded = excluded.superseded, ingest_status = excluded.ingest_status, ingest_error = excluded.ingest_error, indexed_at = excluded.indexed_at`,
        )
        .run(id, projectId, this.repo.mode, item.id, item.name, item.folder, docType, item.webUrl, item.eTag, item.versionLabel, item.lastModified,
          acl ? JSON.stringify(acl) : null, superseded ? 1 : 0, status, error, iso(this.clock.now()));
      const insChunk = this.db.prepare(
        "INSERT INTO chunks (id, document_id, project_id, ordinal, heading, text, provenance, flagged, flag_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const insFts = this.db.prepare("INSERT INTO chunks_fts (chunk_id, heading, text) VALUES (?, ?, ?)");
      chunks.forEach((c, i) => {
        const chunkId = newId();
        const reason = screenForInjection(c.text);
        if (reason) flagged++;
        insChunk.run(chunkId, id, projectId, i, c.heading, c.text, c.provenance, reason ? 1 : 0, reason);
        insFts.run(chunkId, c.heading, c.text);
      });
      this.db.prepare("UPDATE documents SET flagged_chunks = ? WHERE id = ?").run(flagged, id);
    });
  }

  private deleteChunks(documentId: string) {
    this.db.prepare("DELETE FROM chunks_fts WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)").run(documentId);
    this.db.prepare("DELETE FROM chunks WHERE document_id = ?").run(documentId);
  }

  private deleteDocument(documentId: string) {
    transaction(this.db, () => {
      this.deleteChunks(documentId);
      this.db.prepare("DELETE FROM documents WHERE id = ?").run(documentId);
    });
  }

  // --- search -----------------------------------------------------------------

  /**
   * Ranked passages the user is authorised to read: same project, not superseded, and the
   * document's ACL is either inherited (NULL) or names the user. Filtering happens in SQL,
   * before anything is returned to the caller or sent to a model.
   */
  search(user: Principal, projectId: string, question: string, limit = 6): Passage[] {
    const terms = queryTerms(question);
    if (terms.length === 0) return [];
    const staleBefore = iso(addMs(this.clock.now(), -this.staleAfterDays * 86_400_000));
    return this.db
      .prepare(
        `SELECT c.id AS chunk_id, c.heading, c.text, c.provenance, c.flagged, c.flag_reason,
                d.id AS document_id, d.name, d.doc_type, d.web_url, d.version_label, d.last_modified_at,
                bm25(chunks_fts, 0.0, 2.0, 1.0) AS score
         FROM chunks_fts
         JOIN chunks c ON c.id = chunks_fts.chunk_id
         JOIN documents d ON d.id = c.document_id
         WHERE chunks_fts MATCH ?
           AND c.project_id = ?
           AND d.superseded = 0
           AND d.ingest_status = 'indexed'
           AND (d.acl_json IS NULL OR EXISTS (SELECT 1 FROM json_each(d.acl_json) WHERE json_each.value = ?))
         ORDER BY score
         LIMIT ?`,
      )
      .all(ftsQuery(terms), projectId, user.email.toLowerCase(), limit)
      .map((r) => ({
        chunkId: String(r.chunk_id),
        documentId: String(r.document_id),
        documentName: String(r.name),
        docType: r.doc_type as DocType,
        webUrl: String(r.web_url),
        versionLabel: r.version_label ? String(r.version_label) : null,
        lastModifiedAt: r.last_modified_at ? String(r.last_modified_at) : null,
        heading: String(r.heading),
        text: String(r.text),
        provenance: (r.provenance as Provenance | null) ?? null,
        flagged: r.flagged === 1,
        flagReason: r.flag_reason ? String(r.flag_reason) : null,
        stale: r.last_modified_at ? String(r.last_modified_at) < staleBefore : false,
        score: Number(r.score),
      }));
  }

  /** Documents the user may see, for the project's source list. */
  listDocuments(user: Principal, projectId: string) {
    return this.db
      .prepare(
        `SELECT id, name, doc_type, web_url, version_label, last_modified_at, superseded, ingest_status, ingest_error, flagged_chunks, indexed_at
         FROM documents d WHERE project_id = ?
           AND (d.acl_json IS NULL OR EXISTS (SELECT 1 FROM json_each(d.acl_json) WHERE json_each.value = ?))
         ORDER BY doc_type, name`,
      )
      .all(projectId, user.email.toLowerCase())
      .map((r) => ({
        id: String(r.id),
        name: String(r.name),
        docType: r.doc_type as DocType,
        webUrl: String(r.web_url),
        versionLabel: r.version_label,
        lastModifiedAt: r.last_modified_at,
        superseded: r.superseded === 1,
        ingestStatus: r.ingest_status,
        ingestError: r.ingest_error,
        flaggedChunks: Number(r.flagged_chunks),
        indexedAt: r.indexed_at,
      }));
  }

  /** Full text of one document (as indexed), if the user may read it. */
  getDocument(user: Principal, projectId: string, documentId: string) {
    const doc = this.listDocuments(user, projectId).find((d) => d.id === documentId);
    if (!doc) return null;
    const chunks = this.db.prepare("SELECT heading, text, flagged FROM chunks WHERE document_id = ? ORDER BY ordinal").all(documentId);
    return {
      ...doc,
      sections: chunks.map((c) => ({ heading: String(c.heading), text: String(c.text), flagged: c.flagged === 1 })),
    };
  }
}
