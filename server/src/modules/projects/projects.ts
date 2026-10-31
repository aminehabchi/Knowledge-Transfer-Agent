import { z } from "zod";
import type { Db } from "../../db/database.ts";
import { conflict, forbidden, notFound } from "../../lib/errors.ts";
import { iso, newId, type Clock } from "../../lib/util.ts";
import type { AuditLog } from "../audit/audit.ts";
import type { Principal } from "../identity/users.ts";

export type ProjectRole = "manager" | "outgoing" | "incoming";

export interface Project {
  id: string;
  code: string;
  name: string;
  clientName: string;
  description: string;
  status: "active" | "archived";
  createdAt: string;
}

export const CreateProjectInput = z.object({
  code: z.string().trim().regex(/^[A-Z0-9][A-Z0-9-]{1,31}$/, "Use 2-32 upper-case letters, digits or dashes"),
  name: z.string().trim().min(2).max(120),
  clientName: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).default(""),
});

const toProject = (r: Record<string, unknown>): Project => ({
  id: String(r.id),
  code: String(r.code),
  name: String(r.name),
  clientName: String(r.client_name),
  description: String(r.description),
  status: r.status as Project["status"],
  createdAt: String(r.created_at),
});

export class ProjectService {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly audit: AuditLog;
  constructor(db: Db, clock: Clock, audit: AuditLog) {
    this.db = db;
    this.clock = clock;
    this.audit = audit;
  }

  // --- membership / authorization primitives --------------------------------

  rolesOf(userId: string, projectId: string): Set<ProjectRole> {
    const rows = this.db.prepare("SELECT role FROM project_members WHERE project_id = ? AND user_id = ?").all(projectId, userId);
    return new Set(rows.map((r) => r.role as ProjectRole));
  }

  isMember(userId: string, projectId: string): boolean {
    return this.rolesOf(userId, projectId).size > 0;
  }

  /** Throws 404 (not 403) for non-members so project existence is not disclosed. */
  requireMember(user: Principal, projectId: string, roles?: ProjectRole[]): Set<ProjectRole> {
    const mine = this.rolesOf(user.id, projectId);
    const allowed = roles ? roles.some((r) => mine.has(r)) : mine.size > 0;
    if (!allowed) {
      this.audit.record({ actorId: user.id, action: "project.access", entityType: "project", entityId: projectId, projectId, outcome: "denied" });
      if (mine.size === 0) throw notFound("Project");
      throw forbidden();
    }
    return mine;
  }

  addMember(projectId: string, userId: string, role: ProjectRole) {
    this.db
      .prepare("INSERT OR IGNORE INTO project_members (project_id, user_id, role, added_at) VALUES (?, ?, ?, ?)")
      .run(projectId, userId, role, iso(this.clock.now()));
  }

  removeMember(projectId: string, userId: string, role: ProjectRole) {
    this.db.prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ? AND role = ?").run(projectId, userId, role);
  }

  // --- queries ---------------------------------------------------------------

  get(projectId: string): Project {
    const r = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId);
    if (!r) throw notFound("Project");
    return toProject(r);
  }

  getForUser(user: Principal, projectId: string) {
    const roles = this.requireMember(user, projectId);
    return { ...this.get(projectId), myRoles: [...roles], members: this.members(projectId) };
  }

  listForUser(user: Principal) {
    return this.db
      .prepare(
        `SELECT p.*, group_concat(m.role) AS roles FROM projects p
         JOIN project_members m ON m.project_id = p.id AND m.user_id = ?
         GROUP BY p.id ORDER BY p.name`,
      )
      .all(user.id)
      .map((r) => ({ ...toProject(r), myRoles: String(r.roles).split(",") as ProjectRole[] }));
  }

  members(projectId: string) {
    return this.db
      .prepare(
        `SELECT u.id, u.display_name, u.email, m.role FROM project_members m JOIN users u ON u.id = m.user_id
         WHERE m.project_id = ? ORDER BY m.role, u.display_name`,
      )
      .all(projectId)
      .map((r) => ({ userId: String(r.id), displayName: String(r.display_name), email: String(r.email), role: r.role as ProjectRole }));
  }

  /** The managers of a project; used as the authorized escalation contact. */
  managers(projectId: string) {
    return this.members(projectId).filter((m) => m.role === "manager");
  }

  // --- commands --------------------------------------------------------------

  create(actor: Principal, input: unknown): Project {
    if (!actor.isManager) throw forbidden("Only managers can create projects");
    const data = CreateProjectInput.parse(input);
    if (this.db.prepare("SELECT 1 FROM projects WHERE code = ?").get(data.code)) {
      throw conflict(`Project code ${data.code} already exists`);
    }
    const id = newId();
    this.db
      .prepare("INSERT INTO projects (id, code, name, client_name, description, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, data.code, data.name, data.clientName, data.description, actor.id, iso(this.clock.now()));
    this.addMember(id, actor.id, "manager");
    this.audit.record({ actorId: actor.id, action: "project.create", entityType: "project", entityId: id, projectId: id, details: { code: data.code } });
    return this.get(id);
  }
}
