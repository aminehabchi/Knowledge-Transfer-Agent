import { z } from "zod";
import { transaction, type Db } from "../../db/database.ts";
import { badRequest, conflict, forbidden, notFound, unprocessable } from "../../lib/errors.ts";
import { scanForSecrets } from "../../lib/secret-scan.ts";
import { iso, newId, type Clock } from "../../lib/util.ts";
import type { AuditLog } from "../audit/audit.ts";
import type { Principal, UserRepository } from "../identity/users.ts";
import type { JobQueue } from "../jobs/queue.ts";
import type { ProjectService } from "../projects/projects.ts";
import { assessCompleteness } from "./completeness.ts";
import { emptyContent, HandoverContent } from "./schema.ts";
import { allowedActions, transition, type ActorRole, type HandoverAction, type HandoverStatus } from "./workflow.ts";

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export const CreateAssignmentInput = z
  .object({
    projectId: z.string().min(1),
    outgoingUserId: z.string().min(1),
    incomingUserId: z.string().min(1).optional(),
    transferDueDate: isoDay,
    onboardingStartDate: isoDay.optional(),
  })
  .refine((v) => v.outgoingUserId !== v.incomingUserId, { message: "Outgoing and incoming employee must be different people", path: ["incomingUserId"] });

export const SaveDraftInput = z.object({ revision: z.number().int().nonnegative(), content: z.unknown() });
export const SubmitInput = z.object({ attestation: z.literal(true, { message: "You must confirm you reviewed the handover" }) });
export const ReviewInput = z.object({ comment: z.string().trim().max(4000).default("") });
export const RequestChangesInput = z.object({ comment: z.string().trim().min(5, "Explain what needs to change").max(4000) });

type Row = Record<string, unknown>;

export const PUBLISH_JOB = "sharepoint.publish_handover";

export class HandoverService {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly projects: ProjectService;
  private readonly users: UserRepository;
  private readonly jobs: JobQueue;
  private readonly audit: AuditLog;
  private readonly adapterMode: string;

  constructor(deps: { db: Db; clock: Clock; projects: ProjectService; users: UserRepository; jobs: JobQueue; audit: AuditLog; adapterMode: string }) {
    this.adapterMode = deps.adapterMode;
    this.db = deps.db;
    this.clock = deps.clock;
    this.projects = deps.projects;
    this.users = deps.users;
    this.jobs = deps.jobs;
    this.audit = deps.audit;
  }

  private row(id: string): Row {
    const r = this.db.prepare("SELECT * FROM handovers WHERE id = ?").get(id);
    if (!r) throw notFound("Handover");
    return r;
  }

  private actorRoles(user: Principal, r: Row): Set<ActorRole | "incoming"> {
    const roles = new Set<ActorRole | "incoming">();
    if (r.outgoing_user_id === user.id) roles.add("outgoing");
    if (r.manager_id === user.id || this.projects.rolesOf(user.id, String(r.project_id)).has("manager")) roles.add("manager");
    if (r.incoming_user_id === user.id) roles.add("incoming");
    return roles;
  }

  /** Applies the workflow rule or throws; denials are audited. */
  private authorize(user: Principal, r: Row, action: HandoverAction) {
    const roles = this.actorRoles(user, r) as Set<ActorRole>;
    const res = transition(r.status as HandoverStatus, action, roles);
    if (!res.ok) {
      this.audit.record({ actorId: user.id, action: `handover.${action}`, entityType: "handover", entityId: String(r.id), projectId: String(r.project_id), outcome: "denied", details: { reason: res.reason, status: r.status } });
      if (res.reason === "wrong_role") {
        if (this.actorRoles(user, r).size === 0) throw notFound("Handover");
        throw forbidden(`You cannot ${action.replace("_", " ")} this handover`);
      }
      throw conflict(`Cannot ${action.replace("_", " ")} a handover that is ${r.status}`);
    }
    return res.to;
  }

  // --- commands ------------------------------------------------------------------

  createAssignment(actor: Principal, input: unknown) {
    const data = CreateAssignmentInput.parse(input);
    if (!actor.isManager) throw forbidden("Only managers can create handover assignments");
    this.projects.requireMember(actor, data.projectId, ["manager"]);
    const outgoing = this.users.byId(data.outgoingUserId);
    const incoming = data.incomingUserId ? this.users.byId(data.incomingUserId) : null;
    if (!outgoing) throw badRequest("Outgoing employee not found");
    if (data.incomingUserId && !incoming) throw badRequest("Incoming employee not found");
    if (outgoing.id === actor.id) throw badRequest("A manager cannot assign themselves as the outgoing employee");

    const id = newId();
    const now = iso(this.clock.now());
    transaction(this.db, () => {
      try {
        this.db
          .prepare(
            `INSERT INTO handovers (id, project_id, manager_id, outgoing_user_id, incoming_user_id, status, content_json, transfer_due_date, onboarding_start_date, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
          )
          .run(id, data.projectId, actor.id, outgoing.id, incoming?.id ?? null, JSON.stringify(emptyContent()), data.transferDueDate, data.onboardingStartDate ?? null, now, now);
      } catch (err) {
        if (String(err).includes("UNIQUE")) throw conflict("This employee already has an open handover for this project");
        throw err;
      }
      this.projects.addMember(data.projectId, outgoing.id, "outgoing");
      if (incoming) this.projects.addMember(data.projectId, incoming.id, "incoming");
    });
    this.audit.record({ actorId: actor.id, action: "handover.assign", entityType: "handover", entityId: id, projectId: data.projectId, details: { outgoingUserId: outgoing.id, incomingUserId: incoming?.id ?? null } });
    return this.get(actor, id);
  }

  saveDraft(actor: Principal, id: string, input: unknown) {
    const r = this.row(id);
    this.authorize(actor, r, "edit");
    const { revision, content } = SaveDraftInput.parse(input);
    const parsed = HandoverContent.safeParse(content);
    if (!parsed.success) {
      throw unprocessable("Some fields are invalid", parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
    }
    const secrets = scanForSecrets(parsed.data);
    if (secrets.length) {
      this.audit.record({ actorId: actor.id, action: "handover.secret_rejected", entityType: "handover", entityId: id, projectId: String(r.project_id), outcome: "denied", details: { fields: secrets.map((s) => s.path), kinds: secrets.map((s) => s.kind) } });
      throw unprocessable(
        "This looks like a password, key or token. Never store secrets in a handover - reference the secret's name in the approved vault instead.",
        secrets.map((s) => ({ path: s.path, message: `Possible secret (${s.kind.replace(/_/g, " ")})` })),
      );
    }
    const res = this.db
      .prepare("UPDATE handovers SET content_json = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?")
      .run(JSON.stringify(parsed.data), iso(this.clock.now()), id, revision);
    if (res.changes === 0) throw conflict("This handover was changed elsewhere. Reload to get the latest version.", { currentRevision: Number(this.row(id).revision) });
    return { revision: revision + 1, completeness: assessCompleteness(parsed.data), savedAt: iso(this.clock.now()) };
  }

  submit(actor: Principal, id: string, input: unknown) {
    const r = this.row(id);
    const to = this.authorize(actor, r, "submit");
    SubmitInput.parse(input);
    const content = HandoverContent.parse(JSON.parse(String(r.content_json)));
    const completeness = assessCompleteness(content);
    if (!completeness.complete) {
      throw unprocessable("Complete all required sections before submitting", completeness.missing.map((m) => ({ path: m.path, message: `${m.label} is required` })));
    }
    const now = iso(this.clock.now());
    const version = Number(r.current_version) + 1;
    transaction(this.db, () => {
      this.db
        .prepare("INSERT INTO handover_versions (handover_id, version, content_json, submitted_by, submitted_at) VALUES (?, ?, ?, ?, ?)")
        .run(id, version, String(r.content_json), actor.id, now);
      this.db
        .prepare("UPDATE handovers SET status = ?, current_version = ?, author_attested_at = ?, submitted_at = ?, updated_at = ? WHERE id = ?")
        .run(to, version, now, now, now, id);
    });
    this.audit.record({ actorId: actor.id, action: "handover.submit", entityType: "handover", entityId: id, projectId: String(r.project_id), details: { version } });
    return this.get(actor, id);
  }

  approve(actor: Principal, id: string, input: unknown) {
    const r = this.row(id);
    const to = this.authorize(actor, r, "approve");
    const { comment } = ReviewInput.parse(input);
    if (r.outgoing_user_id === actor.id) throw forbidden("The author of a handover cannot approve it");
    const version = Number(r.current_version);
    const now = iso(this.clock.now());
    transaction(this.db, () => {
      this.db.prepare("UPDATE handover_versions SET decision = 'approved', decided_by = ?, decided_at = ? WHERE handover_id = ? AND version = ?").run(actor.id, now, id, version);
      this.db
        .prepare("UPDATE handovers SET status = ?, approved_version = ?, approved_at = ?, reviewed_at = ?, reviewed_by = ?, review_comment = ?, updated_at = ? WHERE id = ?")
        .run(to, version, now, now, actor.id, comment || null, now, id);
      this.db
        .prepare("INSERT OR IGNORE INTO handover_publications (handover_id, version, status, adapter_mode, updated_at) VALUES (?, ?, 'pending', ?, ?)")
        .run(id, version, this.adapterMode, now);
      this.jobs.enqueue(PUBLISH_JOB, { handoverId: id, version }, { dedupeKey: `publish:${id}:v${version}` });
    });
    this.audit.record({ actorId: actor.id, action: "handover.approve", entityType: "handover", entityId: id, projectId: String(r.project_id), details: { version } });
    return this.get(actor, id);
  }

  requestChanges(actor: Principal, id: string, input: unknown) {
    const r = this.row(id);
    const to = this.authorize(actor, r, "request_changes");
    const { comment } = RequestChangesInput.parse(input);
    const now = iso(this.clock.now());
    transaction(this.db, () => {
      this.db
        .prepare("UPDATE handover_versions SET decision = 'changes_requested', decided_by = ?, decided_at = ? WHERE handover_id = ? AND version = ?")
        .run(actor.id, now, id, Number(r.current_version));
      this.db.prepare("UPDATE handovers SET status = ?, reviewed_at = ?, reviewed_by = ?, review_comment = ?, updated_at = ? WHERE id = ?").run(to, now, actor.id, comment, now, id);
    });
    this.audit.record({ actorId: actor.id, action: "handover.request_changes", entityType: "handover", entityId: id, projectId: String(r.project_id), details: { version: Number(r.current_version) } });
    return this.get(actor, id);
  }

  cancel(actor: Principal, id: string, input: unknown) {
    const r = this.row(id);
    const to = this.authorize(actor, r, "cancel");
    const { comment } = RequestChangesInput.parse(input);
    this.db.prepare("UPDATE handovers SET status = ?, review_comment = ?, updated_at = ? WHERE id = ?").run(to, comment, iso(this.clock.now()), id);
    this.audit.record({ actorId: actor.id, action: "handover.cancel", entityType: "handover", entityId: id, projectId: String(r.project_id) });
    return { id, status: to };
  }

  /** Manager-triggered retry of a failed SharePoint publication. */
  retryPublication(actor: Principal, id: string) {
    const r = this.row(id);
    if (!this.actorRoles(actor, r).has("manager")) throw forbidden();
    const pub = this.db.prepare("SELECT * FROM handover_publications WHERE handover_id = ? AND version = ?").get(id, r.approved_version == null ? -1 : Number(r.approved_version));
    if (!pub) throw conflict("This handover has no approved version to publish");
    if (pub.status === "synced") throw conflict("Already published");
    this.db.prepare("UPDATE handover_publications SET status = 'pending', updated_at = ? WHERE handover_id = ? AND version = ?").run(iso(this.clock.now()), id, Number(pub.version));
    this.jobs.enqueue(PUBLISH_JOB, { handoverId: id, version: Number(pub.version) }, { dedupeKey: `publish:${id}:v${pub.version}` });
    this.audit.record({ actorId: actor.id, action: "handover.publish_retry", entityType: "handover", entityId: id, projectId: String(r.project_id) });
    return { queued: true };
  }

  // --- queries -------------------------------------------------------------------

  get(actor: Principal, id: string) {
    const r = this.row(id);
    const roles = this.actorRoles(actor, r);
    const status = r.status as HandoverStatus;
    const isEditorOrReviewer = roles.has("outgoing") || roles.has("manager");
    if (!isEditorOrReviewer) {
      // Incoming employees only ever see the approved, immutable version.
      if (!roles.has("incoming") || r.approved_version == null) {
        this.audit.record({ actorId: actor.id, action: "handover.read", entityType: "handover", entityId: id, projectId: String(r.project_id), outcome: "denied" });
        throw notFound("Handover");
      }
    }
    const project = this.projects.get(String(r.project_id));
    const approved =
      r.approved_version != null
        ? this.db.prepare("SELECT content_json FROM handover_versions WHERE handover_id = ? AND version = ?").get(id, Number(r.approved_version))
        : null;
    const working = isEditorOrReviewer ? HandoverContent.parse(JSON.parse(String(r.content_json))) : null;
    const submitted =
      isEditorOrReviewer && Number(r.current_version) > 0
        ? HandoverContent.parse(JSON.parse(String(this.db.prepare("SELECT content_json FROM handover_versions WHERE handover_id = ? AND version = ?").get(id, Number(r.current_version))!.content_json)))
        : null;
    return {
      id,
      project: { id: project.id, code: project.code, name: project.name, clientName: project.clientName },
      status,
      myRoles: [...roles],
      allowedActions: allowedActions(status, roles as Set<ActorRole>),
      manager: this.person(String(r.manager_id)),
      outgoing: this.person(String(r.outgoing_user_id)),
      incoming: r.incoming_user_id ? this.person(String(r.incoming_user_id)) : null,
      transferDueDate: String(r.transfer_due_date),
      onboardingStartDate: r.onboarding_start_date ? String(r.onboarding_start_date) : null,
      revision: Number(r.revision),
      currentVersion: Number(r.current_version),
      approvedVersion: r.approved_version == null ? null : Number(r.approved_version),
      submittedAt: r.submitted_at ?? null,
      authorAttestedAt: r.author_attested_at ?? null,
      reviewedAt: r.reviewed_at ?? null,
      reviewedBy: r.reviewed_by ? this.person(String(r.reviewed_by)) : null,
      reviewComment: r.review_comment ?? null,
      approvedAt: r.approved_at ?? null,
      updatedAt: String(r.updated_at),
      /** Working draft - only for the author and reviewers. */
      content: working,
      /** The version currently under review / last submitted - for reviewers. */
      submittedContent: submitted,
      approvedContent: approved ? HandoverContent.parse(JSON.parse(String(approved.content_json))) : null,
      completeness: working ? assessCompleteness(working) : null,
      versions: isEditorOrReviewer ? this.versions(id) : [],
      publication: this.publication(id, r.approved_version == null ? null : Number(r.approved_version)),
    };
  }

  /** Follow-up questions for the guided interview (missing required fields + quality checks). */
  interview(actor: Principal, id: string) {
    const r = this.row(id);
    const roles = this.actorRoles(actor, r);
    if (!roles.has("outgoing") && !roles.has("manager")) throw notFound("Handover");
    const c = assessCompleteness(HandoverContent.parse(JSON.parse(String(r.content_json))));
    return {
      completeness: c,
      questions: [
        ...c.missing.map((m) => ({ section: m.section, path: m.path, question: m.question, reason: `${m.label} is required` })),
        ...c.quality.map((q) => ({ section: q.path.split(".")[0] || "risks", path: q.path, question: q.question, reason: q.message })),
      ],
    };
  }

  list(actor: Principal, filter: { status?: string; projectId?: string } = {}) {
    const rows = this.db
      .prepare(
        `SELECT h.*, p.code, p.name AS project_name, p.client_name FROM handovers h JOIN projects p ON p.id = h.project_id
         WHERE (h.manager_id = :me OR h.outgoing_user_id = :me
                OR (h.incoming_user_id = :me AND h.approved_version IS NOT NULL)
                OR EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = h.project_id AND m.user_id = :me AND m.role = 'manager'))
           AND (:status IS NULL OR h.status = :status)
           AND (:project IS NULL OR h.project_id = :project)
         ORDER BY h.updated_at DESC`,
      )
      .all({ me: actor.id, status: filter.status ?? null, project: filter.projectId ?? null });
    const today = iso(this.clock.now()).slice(0, 10);
    return rows.map((r) => {
      const roles = this.actorRoles(actor, r);
      const canSeeDraft = roles.has("outgoing") || roles.has("manager");
      const completeness = canSeeDraft ? assessCompleteness(HandoverContent.parse(JSON.parse(String(r.content_json)))) : null;
      return {
        id: String(r.id),
        project: { id: String(r.project_id), code: String(r.code), name: String(r.project_name), clientName: String(r.client_name) },
        status: r.status as HandoverStatus,
        myRoles: [...roles],
        outgoing: this.person(String(r.outgoing_user_id)),
        incoming: r.incoming_user_id ? this.person(String(r.incoming_user_id)) : null,
        manager: this.person(String(r.manager_id)),
        transferDueDate: String(r.transfer_due_date),
        overdue: r.status !== "approved" && r.status !== "cancelled" && String(r.transfer_due_date) < today,
        completenessPercent: completeness?.percent ?? null,
        missingSections: completeness ? [...new Set(completeness.missing.map((m) => m.section))] : [],
        publication: this.publication(String(r.id), r.approved_version == null ? null : Number(r.approved_version)),
        updatedAt: String(r.updated_at),
      };
    });
  }

  private versions(id: string) {
    return this.db
      .prepare("SELECT version, submitted_by, submitted_at, decision, decided_by, decided_at FROM handover_versions WHERE handover_id = ? ORDER BY version DESC")
      .all(id)
      .map((v) => ({
        version: Number(v.version),
        submittedBy: this.person(String(v.submitted_by)),
        submittedAt: String(v.submitted_at),
        decision: v.decision ?? null,
        decidedBy: v.decided_by ? this.person(String(v.decided_by)) : null,
        decidedAt: v.decided_at ?? null,
      }));
  }

  private publication(id: string, version: number | null) {
    if (version == null) return null;
    const p = this.db.prepare("SELECT * FROM handover_publications WHERE handover_id = ? AND version = ?").get(id, version);
    if (!p) return null;
    return {
      version,
      status: p.status as "pending" | "synced" | "failed",
      adapterMode: String(p.adapter_mode),
      webUrl: p.web_url ? String(p.web_url) : null,
      remotePath: p.remote_path ? String(p.remote_path) : null,
      metadataStatus: p.metadata_status ?? null,
      attempts: Number(p.attempts),
      lastError: p.last_error ?? null,
      syncedAt: p.synced_at ?? null,
    };
  }

  private person(userId: string) {
    const u = this.users.byId(userId);
    return u ? { id: u.id, displayName: u.displayName, email: u.email } : { id: userId, displayName: "Unknown user", email: "" };
  }
}
