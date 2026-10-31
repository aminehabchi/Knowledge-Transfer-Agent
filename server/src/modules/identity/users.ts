import type { Db } from "../../db/database.ts";
import { iso, newId, type Clock } from "../../lib/util.ts";

export interface Principal {
  id: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
  isManager: boolean;
}

type Row = Record<string, unknown>;

export const toPrincipal = (r: Row): Principal => ({
  id: String(r.id),
  email: String(r.email).toLowerCase(),
  displayName: String(r.display_name),
  isAdmin: r.is_admin === 1,
  isManager: r.is_manager === 1,
});

export class UserRepository {
  private readonly db: Db;
  private readonly clock: Clock;
  constructor(db: Db, clock: Clock) {
    this.db = db;
    this.clock = clock;
  }

  byId(id: string): Principal | null {
    const r = this.db.prepare("SELECT * FROM users WHERE id = ? AND is_active = 1").get(id);
    return r ? toPrincipal(r) : null;
  }

  byEmail(email: string): Principal | null {
    const r = this.db.prepare("SELECT * FROM users WHERE email = ? AND is_active = 1").get(email);
    return r ? toPrincipal(r) : null;
  }

  byEntraOid(oid: string): Principal | null {
    const r = this.db.prepare("SELECT * FROM users WHERE entra_oid = ? AND is_active = 1").get(oid);
    return r ? toPrincipal(r) : null;
  }

  linkEntraOid(userId: string, oid: string) {
    this.db.prepare("UPDATE users SET entra_oid = ? WHERE id = ? AND entra_oid IS NULL").run(oid, userId);
  }

  create(u: { email: string; displayName: string; isAdmin?: boolean; isManager?: boolean; entraOid?: string; synthetic?: boolean }): Principal {
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO users (id, email, display_name, entra_oid, is_admin, is_manager, is_synthetic, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, u.email.toLowerCase(), u.displayName, u.entraOid ?? null, u.isAdmin ? 1 : 0, u.isManager ? 1 : 0, u.synthetic ? 1 : 0, iso(this.clock.now()));
    return this.byId(id)!;
  }

  /** Directory listing used for assignment pickers; returns identity fields only. */
  search(query: string, limit = 20): Principal[] {
    const like = `%${query.replace(/[%_]/g, "")}%`;
    return this.db
      .prepare("SELECT * FROM users WHERE is_active = 1 AND (email LIKE ? OR display_name LIKE ?) ORDER BY display_name LIMIT ?")
      .all(like, like, limit)
      .map(toPrincipal);
  }

  /** Synthetic accounts offered on the demo login screen. */
  listSynthetic(): Principal[] {
    return this.db.prepare("SELECT * FROM users WHERE is_active = 1 AND is_synthetic = 1 ORDER BY display_name").all().map(toPrincipal);
  }
}
