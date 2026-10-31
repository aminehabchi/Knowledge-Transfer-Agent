import { createHash } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Db } from "../../db/database.ts";
import type { Config } from "../../config.ts";
import { AppError } from "../../lib/errors.ts";
import { addMs, iso, randomToken, type Clock } from "../../lib/util.ts";

export interface EntraIdentity {
  oid: string;
  tenantId: string;
  email: string;
  name: string;
}

export type FetchFn = typeof fetch;

/**
 * Microsoft Entra ID sign-in using the OIDC authorization-code flow with PKCE
 * (confidential web client). The id_token is verified against the tenant's JWKS:
 * signature, issuer, audience, expiry, nonce and tenant.
 */
export class EntraOidc {
  private readonly cfg: Config;
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly fetchFn: FetchFn;
  private readonly keys: JWTVerifyGetKey;

  constructor(cfg: Config, db: Db, clock: Clock, opts: { fetchFn?: FetchFn; keys?: JWTVerifyGetKey } = {}) {
    this.cfg = cfg;
    this.db = db;
    this.clock = clock;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.keys = opts.keys ?? createRemoteJWKSet(new URL(`${this.authority}/discovery/v2.0/keys`));
  }

  private get authority() {
    return `https://login.microsoftonline.com/${this.cfg.ENTRA_TENANT_ID}`;
  }

  get issuer() {
    return `https://login.microsoftonline.com/${this.cfg.ENTRA_TENANT_ID}/v2.0`;
  }

  /** Persists state/nonce/PKCE verifier and returns the authorize URL to redirect to. */
  beginLogin(returnTo: string): string {
    const state = randomToken();
    const nonce = randomToken();
    const verifier = randomToken(48);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    this.db
      .prepare("INSERT INTO auth_requests (state, nonce, code_verifier, return_to, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(state, nonce, verifier, safeReturnTo(returnTo), iso(addMs(this.clock.now(), 10 * 60_000)));
    const params = new URLSearchParams({
      client_id: this.cfg.ENTRA_CLIENT_ID!,
      response_type: "code",
      redirect_uri: this.cfg.ENTRA_REDIRECT_URI!,
      response_mode: "query",
      scope: "openid profile email",
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    return `${this.authority}/oauth2/v2.0/authorize?${params}`;
  }

  async completeLogin(state: string, code: string): Promise<{ identity: EntraIdentity; returnTo: string }> {
    const req = this.db.prepare("SELECT * FROM auth_requests WHERE state = ?").get(state);
    this.db.prepare("DELETE FROM auth_requests WHERE state = ?").run(state);
    if (!req || String(req.expires_at) <= iso(this.clock.now())) {
      throw new AppError(400, "login_expired", "Sign-in request expired or is invalid. Please sign in again.");
    }
    const res = await this.fetchFn(`${this.authority}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.cfg.ENTRA_CLIENT_ID!,
        client_secret: this.cfg.ENTRA_CLIENT_SECRET!,
        grant_type: "authorization_code",
        code,
        redirect_uri: this.cfg.ENTRA_REDIRECT_URI!,
        code_verifier: String(req.code_verifier),
      }),
    });
    if (!res.ok) throw new AppError(401, "login_failed", "Sign-in with Microsoft Entra ID failed");
    const body = (await res.json()) as { id_token?: string };
    if (!body.id_token) throw new AppError(401, "login_failed", "Sign-in with Microsoft Entra ID failed");
    const identity = await this.verifyIdToken(body.id_token, String(req.nonce));
    return { identity, returnTo: String(req.return_to) };
  }

  async verifyIdToken(idToken: string, expectedNonce: string): Promise<EntraIdentity> {
    try {
      const { payload } = await jwtVerify(idToken, this.keys, {
        issuer: this.issuer,
        audience: this.cfg.ENTRA_CLIENT_ID,
        currentDate: this.clock.now(),
      });
      if (payload.nonce !== expectedNonce) throw new Error("nonce mismatch");
      if (payload.tid !== this.cfg.ENTRA_TENANT_ID) throw new Error("tenant mismatch");
      const email = String(payload.email ?? payload.preferred_username ?? "").toLowerCase();
      if (!payload.oid || !email) throw new Error("missing oid/email claims");
      return { oid: String(payload.oid), tenantId: String(payload.tid), email, name: String(payload.name ?? email) };
    } catch {
      throw new AppError(401, "login_failed", "Sign-in with Microsoft Entra ID failed");
    }
  }
}

/** Only same-origin relative paths are allowed as post-login redirect targets. */
export function safeReturnTo(value: string | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  return value;
}
