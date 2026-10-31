import type { Db } from "../../db/database.ts";
import { iso, newId, type Clock } from "../../lib/util.ts";

export interface AuditEvent {
  actorId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  projectId?: string | null;
  outcome?: "success" | "denied" | "failure";
  /** Must never contain tokens, secrets or free-text content. Identifiers and statuses only. */
  details?: Record<string, unknown>;
}

export class AuditLog {
  private readonly db: Db;
  private readonly clock: Clock;
  constructor(db: Db, clock: Clock) {
    this.db = db;
    this.clock = clock;
  }

  record(e: AuditEvent): void {
    this.db
      .prepare(
        `INSERT INTO audit_events (id, occurred_at, actor_id, action, entity_type, entity_id, project_id, outcome, details_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId(),
        iso(this.clock.now()),
        e.actorId,
        e.action,
        e.entityType,
        e.entityId ?? null,
        e.projectId ?? null,
        e.outcome ?? "success",
        e.details ? JSON.stringify(e.details) : null,
      );
  }

  list(filter: { projectId?: string; limit?: number; offset?: number } = {}) {
    const where = filter.projectId ? "WHERE project_id = ?" : "";
    const params: (string | number)[] = filter.projectId ? [filter.projectId] : [];
    return this.db
      .prepare(`SELECT * FROM audit_events ${where} ORDER BY occurred_at DESC, id LIMIT ? OFFSET ?`)
      .all(...params, filter.limit ?? 50, filter.offset ?? 0)
      .map((r) => ({
        id: r.id,
        occurredAt: r.occurred_at,
        actorId: r.actor_id,
        action: r.action,
        entityType: r.entity_type,
        entityId: r.entity_id,
        projectId: r.project_id,
        outcome: r.outcome,
        details: r.details_json ? JSON.parse(String(r.details_json)) : null,
      }));
  }
}
