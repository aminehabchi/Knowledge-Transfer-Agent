import type { Db } from "../../db/database.ts";
import { addMs, iso, randomToken, sha256, type Clock } from "../../lib/util.ts";
import type { Principal, UserRepository } from "./users.ts";

export interface Session {
  user: Principal;
  csrfToken: string;
  expiresAt: string;
}

/** Opaque server-side sessions. Only the SHA-256 of the cookie token is stored. */
export class SessionStore {
  private readonly db: Db;
  private readonly users: UserRepository;
  private readonly clock: Clock;
  private readonly ttlMs: number;
  constructor(db: Db, users: UserRepository, clock: Clock, ttlHours: number) {
    this.db = db;
    this.users = users;
    this.clock = clock;
    this.ttlMs = ttlHours * 3600_000;
  }

  create(userId: string): { token: string; session: Session } {
    const token = randomToken();
    const csrfToken = randomToken(24);
    const now = this.clock.now();
    const expiresAt = iso(addMs(now, this.ttlMs));
    this.db
      .prepare("INSERT INTO sessions (token_hash, user_id, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(sha256(token), userId, csrfToken, iso(now), expiresAt);
    return { token, session: { user: this.users.byId(userId)!, csrfToken, expiresAt } };
  }

  resolve(token: string | undefined): Session | null {
    if (!token) return null;
    const r = this.db.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(sha256(token));
    if (!r) return null;
    if (String(r.expires_at) <= iso(this.clock.now())) {
      this.destroy(token);
      return null;
    }
    const user = this.users.byId(String(r.user_id));
    if (!user) return null;
    return { user, csrfToken: String(r.csrf_token), expiresAt: String(r.expires_at) };
  }

  destroy(token: string) {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
  }

  purgeExpired() {
    this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(iso(this.clock.now()));
    this.db.prepare("DELETE FROM auth_requests WHERE expires_at <= ?").run(iso(this.clock.now()));
  }
}
