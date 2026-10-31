import cookie from "@fastify/cookie";
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { ZodError } from "zod";
import { AppError, badRequest, forbidden, unauthenticated } from "./lib/errors.ts";
import { safeReturnTo } from "./modules/identity/entra.ts";
import type { Session } from "./modules/identity/sessions.ts";
import type { Principal } from "./modules/identity/users.ts";
import type { Services } from "./services.ts";

const SESSION_COOKIE = "kta_session";

declare module "fastify" {
  interface FastifyRequest {
    session: Session | null;
    sessionToken: string | undefined;
  }
}

const PUBLIC_API = new Set(["/api/auth/config", "/api/auth/demo-login", "/api/auth/login", "/api/auth/callback", "/api/auth/session"]);

export async function buildApp(s: Services): Promise<FastifyInstance> {
  const { cfg } = s;
  const app = Fastify({
    loggerInstance: s.pinoLogger as FastifyBaseLogger,
    bodyLimit: 1024 * 1024,
    trustProxy: cfg.NODE_ENV === "production",
  });
  await app.register(cookie);

  app.decorateRequest("session", null);
  app.decorateRequest("sessionToken", undefined);

  // --- security headers, session resolution, CSRF ------------------------------
  app.addHook("onSend", async (_req, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "same-origin");
    reply.header("x-frame-options", "DENY");
    reply.header(
      "content-security-policy",
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://login.microsoftonline.com",
    );
  });

  app.addHook("onRequest", async (req) => {
    req.sessionToken = req.cookies[SESSION_COOKIE];
    req.session = s.sessions.resolve(req.sessionToken);
    const path = req.url.split("?")[0]!;
    if (!path.startsWith("/api/") || PUBLIC_API.has(path)) return;
    if (!req.session) throw unauthenticated();
    if (req.method !== "GET" && req.method !== "HEAD" && req.headers["x-csrf-token"] !== req.session.csrfToken) {
      throw forbidden("Missing or invalid CSRF token");
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      if (err.statusCode === 429) reply.header("retry-after", String((err.details as { retryAfterSeconds: number }).retryAfterSeconds));
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: { code: "validation_failed", message: "Some fields are invalid", details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
      });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.status(status).send({ error: { code: "bad_request", message: "The request could not be processed" } });
    }
    req.log.error({ err }, "unhandled error");
    return reply.status(500).send({ error: { code: "internal_error", message: "Something went wrong. The error has been logged." } });
  });

  const user = (req: FastifyRequest): Principal => {
    if (!req.session) throw unauthenticated();
    return req.session.user;
  };
  const param = (req: FastifyRequest, name: string) => String((req.params as Record<string, string>)[name]);

  const startSession = (reply: FastifyReply, userId: string) => {
    const { token, session } = s.sessions.create(userId);
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: cfg.NODE_ENV === "production",
      path: "/",
      maxAge: cfg.SESSION_TTL_HOURS * 3600,
    });
    return session;
  };

  // --- health & system -----------------------------------------------------------
  app.get("/healthz", async () => {
    s.db.prepare("SELECT 1").get();
    return { ok: true };
  });

  app.get("/api/system/status", async () => ({
    environment: cfg.NODE_ENV,
    auth: { mode: cfg.AUTH_MODE, simulated: cfg.AUTH_MODE === "demo" },
    sharepoint: { mode: s.repo.mode, simulated: s.repo.simulated },
    assistant: { provider: s.provider.id, label: s.provider.label, generative: s.provider.generative },
  }));

  // --- auth -----------------------------------------------------------------------
  app.get("/api/auth/config", async () => ({
    mode: cfg.AUTH_MODE,
    demoUsers: cfg.AUTH_MODE === "demo" ? s.users.listSynthetic().map((u) => ({ email: u.email, displayName: u.displayName, isManager: u.isManager, isAdmin: u.isAdmin })) : [],
  }));

  app.post("/api/auth/demo-login", async (req, reply) => {
    if (cfg.AUTH_MODE !== "demo") throw forbidden("Demo login is disabled");
    s.loginLimiter.consume(`login:${req.ip}`);
    const email = String((req.body as { email?: string } | null)?.email ?? "");
    const u = s.users.byEmail(email);
    // Demo login is restricted to synthetic accounts.
    if (!u || !s.users.listSynthetic().some((x) => x.id === u.id)) throw badRequest("Unknown demo user");
    const session = startSession(reply, u.id);
    s.audit.record({ actorId: u.id, action: "auth.login", entityType: "user", entityId: u.id, details: { method: "demo" } });
    return { user: session.user, csrfToken: session.csrfToken };
  });

  app.get("/api/auth/login", async (req, reply) => {
    if (!s.entra) throw forbidden("Microsoft Entra ID sign-in is not configured");
    const returnTo = safeReturnTo((req.query as { returnTo?: string }).returnTo);
    return reply.redirect(s.entra.beginLogin(returnTo));
  });

  app.get("/api/auth/callback", async (req, reply) => {
    if (!s.entra) throw forbidden("Microsoft Entra ID sign-in is not configured");
    const q = req.query as { code?: string; state?: string; error?: string };
    if (q.error || !q.code || !q.state) return reply.redirect("/login?error=signin_failed");
    try {
      const { identity, returnTo } = await s.entra.completeLogin(q.state, q.code);
      let u = s.users.byEntraOid(identity.oid) ?? s.users.byEmail(identity.email);
      if (u) s.users.linkEntraOid(u.id, identity.oid);
      else if (cfg.ENTRA_AUTO_PROVISION) u = s.users.create({ email: identity.email, displayName: identity.name, entraOid: identity.oid });
      if (!u) {
        s.audit.record({ actorId: null, action: "auth.login", entityType: "user", outcome: "denied", details: { method: "entra", reason: "not_provisioned" } });
        return reply.redirect("/login?error=not_provisioned");
      }
      startSession(reply, u.id);
      s.audit.record({ actorId: u.id, action: "auth.login", entityType: "user", entityId: u.id, details: { method: "entra" } });
      return reply.redirect(returnTo);
    } catch {
      return reply.redirect("/login?error=signin_failed");
    }
  });

  app.get("/api/auth/session", async (req) => {
    if (!req.session) throw unauthenticated();
    return { user: req.session.user, csrfToken: req.session.csrfToken, expiresAt: req.session.expiresAt };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    if (req.sessionToken) s.sessions.destroy(req.sessionToken);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  // --- users ----------------------------------------------------------------------
  app.get("/api/users", async (req) => {
    const me = user(req);
    if (!me.isManager && !me.isAdmin) throw forbidden();
    const q = String((req.query as { query?: string }).query ?? "").slice(0, 100);
    return s.users.search(q).map((u) => ({ id: u.id, displayName: u.displayName, email: u.email }));
  });

  // --- projects -------------------------------------------------------------------
  app.get("/api/projects", async (req) => s.projects.listForUser(user(req)));
  app.post("/api/projects", async (req) => s.projects.create(user(req), req.body ?? {}));
  app.get("/api/projects/:id", async (req) => s.projects.getForUser(user(req), param(req, "id")));

  app.get("/api/projects/:id/documents", async (req) => {
    const me = user(req);
    s.projects.requireMember(me, param(req, "id"));
    return s.index.listDocuments(me, param(req, "id"));
  });

  app.get("/api/projects/:id/documents/:docId", async (req) => {
    const me = user(req);
    const projectId = param(req, "id");
    s.projects.requireMember(me, projectId);
    const doc = s.index.getDocument(me, projectId, param(req, "docId"));
    if (!doc) {
      s.audit.record({ actorId: me.id, action: "document.read", entityType: "document", entityId: param(req, "docId"), projectId, outcome: "denied" });
      throw new AppError(404, "not_found", "Document not found");
    }
    s.audit.record({ actorId: me.id, action: "document.read", entityType: "document", entityId: doc.id, projectId });
    return doc;
  });

  app.post("/api/projects/:id/reindex", async (req) => {
    const me = user(req);
    const projectId = param(req, "id");
    s.projects.requireMember(me, projectId, ["manager"]);
    const queued = s.jobs.enqueue("retrieval.ingest_project", { projectId }, { dedupeKey: `ingest:${projectId}` });
    s.audit.record({ actorId: me.id, action: "retrieval.reindex_requested", entityType: "project", entityId: projectId, projectId });
    return { queued: queued !== null };
  });

  // --- handovers ------------------------------------------------------------------
  app.get("/api/handovers", async (req) => {
    const q = req.query as { status?: string; projectId?: string };
    return s.handovers.list(user(req), { status: q.status || undefined, projectId: q.projectId || undefined });
  });
  app.post("/api/handovers", async (req) => s.handovers.createAssignment(user(req), req.body));
  app.get("/api/handovers/:id", async (req) => s.handovers.get(user(req), param(req, "id")));
  app.put("/api/handovers/:id/draft", async (req) => s.handovers.saveDraft(user(req), param(req, "id"), req.body));
  app.get("/api/handovers/:id/interview", async (req) => s.handovers.interview(user(req), param(req, "id")));
  app.post("/api/handovers/:id/submit", async (req) => s.handovers.submit(user(req), param(req, "id"), req.body ?? {}));
  app.post("/api/handovers/:id/approve", async (req) => s.handovers.approve(user(req), param(req, "id"), req.body ?? {}));
  app.post("/api/handovers/:id/request-changes", async (req) => s.handovers.requestChanges(user(req), param(req, "id"), req.body ?? {}));
  app.post("/api/handovers/:id/cancel", async (req) => s.handovers.cancel(user(req), param(req, "id"), req.body ?? {}));
  app.post("/api/handovers/:id/retry-publication", async (req) => s.handovers.retryPublication(user(req), param(req, "id")));

  // --- assistant ------------------------------------------------------------------
  app.post("/api/projects/:id/assistant/ask", async (req) => s.assistant.ask(user(req), param(req, "id"), req.body));
  app.get("/api/projects/:id/assistant/history", async (req) => s.assistant.history(user(req), param(req, "id")));

  // --- integrations & admin -------------------------------------------------------
  app.get("/api/integrations/health", async (req) => {
    const me = user(req);
    if (!me.isManager && !me.isAdmin) throw forbidden();
    const publications = s.db
      .prepare("SELECT status, COUNT(*) AS n FROM handover_publications GROUP BY status")
      .all()
      .reduce<Record<string, number>>((acc, r) => ({ ...acc, [String(r.status)]: Number(r.n) }), {});
    return {
      sharepoint: await s.repo.health(),
      assistant: { provider: s.provider.id, label: s.provider.label, generative: s.provider.generative },
      email: { mode: "not_configured", simulated: true, detail: "Email notifications arrive in a later milestone." },
      publications,
      jobs: s.jobs.stats(),
      recentJobFailures: me.isAdmin ? s.jobs.recentFailures() : [],
    };
  });

  app.get("/api/admin/audit", async (req) => {
    const me = user(req);
    if (!me.isAdmin) throw forbidden();
    const q = req.query as { projectId?: string; limit?: string; offset?: string };
    return s.audit.list({ projectId: q.projectId || undefined, limit: Math.min(Number(q.limit ?? 50) || 50, 200), offset: Number(q.offset ?? 0) || 0 });
  });

  // --- demo presenter support (demo mode only) -------------------------------------
  // Progress of the scripted ORION story, for the presenter's guide. Returns statuses and ids only,
  // never handover content, and is disabled outside AUTH_MODE=demo (synthetic data only).
  app.get("/api/demo/state", async (req) => {
    if (cfg.AUTH_MODE !== "demo") throw new AppError(404, "not_found", "Endpoint not found");
    user(req);
    const project = s.db.prepare("SELECT id FROM projects WHERE code = 'ORION'").get();
    if (!project) return { available: false };
    const h = s.db
      .prepare("SELECT id, status, approved_version FROM handovers WHERE project_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(String(project.id));
    const pub = h?.approved_version != null
      ? s.db.prepare("SELECT status FROM handover_publications WHERE handover_id = ? AND version = ?").get(String(h.id), Number(h.approved_version))
      : null;
    const asked = s.db
      .prepare("SELECT COUNT(*) AS n FROM assistant_messages m JOIN users u ON u.id = m.user_id WHERE m.project_id = ? AND u.email = 'lina.park@example.com' AND m.created_at >= COALESCE((SELECT approved_at FROM handovers WHERE id = ?), '9999')")
      .get(String(project.id), h ? String(h.id) : "");
    return {
      available: true,
      projectId: String(project.id),
      handoverId: h ? String(h.id) : null,
      handoverStatus: h ? String(h.status) : null,
      publicationStatus: pub ? String(pub.status) : null,
      askedAfterApproval: Number(asked?.n ?? 0) > 0,
    };
  });

  app.all("/api/*", async () => {
    throw new AppError(404, "not_found", "Endpoint not found");
  });

  if (cfg.WEB_DIST_DIR) serveSpa(app, resolve(cfg.WEB_DIST_DIR));
  return app;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

/** Serves the built SPA with path-traversal protection; unknown paths fall back to index.html. */
function serveSpa(app: FastifyInstance, root: string) {
  const index = join(root, "index.html");
  if (!existsSync(index)) return;
  app.get("/*", async (req, reply) => {
    const rel = normalize(decodeURIComponent(req.url.split("?")[0]!)).replace(/^([/\\])+/, "");
    const file = resolve(root, rel);
    const target = file.startsWith(root + "/") && existsSync(file) && statSync(file).isFile() ? file : index;
    const isAsset = target !== index && rel.startsWith("assets/");
    reply.header("cache-control", isAsset ? "public, max-age=31536000, immutable" : "no-cache");
    return reply.type(MIME[extname(target)] ?? "application/octet-stream").send(readFileSync(target));
  });
}
