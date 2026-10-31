import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { orionHandover } from "../../src/seed/synthetic.ts";
import { Client, setup } from "../helpers.ts";

describe("authentication & session security", () => {
  it("rejects unauthenticated API access", async () => {
    const env = await setup();
    const res = await env.app.inject({ method: "GET", url: "/api/projects" });
    assert.equal(res.statusCode, 401);
  });

  it("rejects mutations without the CSRF token", async () => {
    const env = await setup();
    const maya = await env.login("manager");
    const res = await maya.req("POST", "/api/projects", { code: "CSRF1", name: "No token", clientName: "X" }, { csrf: false });
    assert.equal(res.status, 403);
    assert.match(res.body.error.message, /CSRF/);
  });

  it("expires sessions after the configured TTL", async () => {
    const env = await setup();
    const maya = await env.login("manager");
    assert.equal((await maya.get("/api/projects")).status, 200);
    env.clock.advance(11 * 3600_000);
    assert.equal((await maya.get("/api/projects")).status, 401);
  });

  it("demo login only accepts synthetic accounts and is disabled outside demo mode", async () => {
    const env = await setup();
    env.s.users.create({ email: "real.person@example.org", displayName: "Real Person" });
    await assert.rejects(Client.login(env.app, "real.person@example.org"));
    const entra = await setup({
      cfg: { AUTH_MODE: "entra", ENTRA_TENANT_ID: "t", ENTRA_CLIENT_ID: "c", ENTRA_CLIENT_SECRET: "s", ENTRA_REDIRECT_URI: "http://localhost/api/auth/callback" },
      seed: false,
    });
    const res = await entra.app.inject({ method: "POST", url: "/api/auth/demo-login", payload: { email: "maya.chen@example.com" } });
    assert.equal(res.statusCode, 403);
  });

  it("never writes session tokens or CSRF tokens to the logs", async () => {
    const lines: string[] = [];
    const logStream = { write: (l: string) => void lines.push(l) } as unknown as NodeJS.WritableStream;
    const env = await setup({ cfg: { LOG_LEVEL: "info" }, overrides: { logStream } });
    const maya = await env.login("manager");
    await maya.get("/api/projects");
    await maya.post("/api/projects", { code: "LOGS", name: "Log test", clientName: "X" });
    const all = lines.join("\n");
    assert.ok(lines.length > 0, "expected request logs");
    assert.ok(!all.includes(maya.cookie.split("=")[1]!), "session token leaked into logs");
    assert.ok(!all.includes(maya.csrf), "csrf token leaked into logs");
  });
});

describe("role-based and project-scoped authorization", () => {
  it("hides other projects entirely (404, not 403)", async () => {
    const env = await setup();
    const lina = await env.login("incoming");
    const vega = env.seed.projects.vega;
    for (const url of [`/api/projects/${vega}`, `/api/projects/${vega}/documents`, `/api/projects/${vega}/assistant/history`]) {
      assert.equal((await lina.get(url)).status, 404, url);
    }
    assert.equal((await lina.post(`/api/projects/${vega}/assistant/ask`, { question: "What is the deployment pipeline?" })).status, 404);
    assert.deepEqual((await lina.get("/api/projects")).body.map((p: { code: string }) => p.code), ["ORION"]);
  });

  it("only managers create projects, assignments, and search the directory", async () => {
    const env = await setup();
    const omar = await env.login("outgoing");
    assert.equal((await omar.post("/api/projects", { code: "NOPE", name: "Nope", clientName: "X" })).status, 403);
    assert.equal((await omar.post("/api/handovers", { projectId: env.seed.projects.orion, outgoingUserId: env.seed.users.incoming, transferDueDate: "2026-12-01" })).status, 403);
    assert.equal((await omar.get("/api/users?query=a")).status, 403);
  });

  it("a manager of another project cannot assign, review or read Orion handovers", async () => {
    const env = await setup();
    const priya = await env.login("otherManager");
    assert.equal((await priya.post("/api/handovers", { projectId: env.seed.projects.orion, outgoingUserId: env.seed.users.otherEmployee, transferDueDate: "2026-12-01" })).status, 404);
    assert.equal((await priya.get(`/api/handovers/${env.seed.handoverId}`)).status, 404);
    assert.equal((await priya.post(`/api/handovers/${env.seed.handoverId}/approve`, {})).status, 404);
  });

  it("the outgoing employee cannot approve their own handover; the incoming employee cannot edit it", async () => {
    const env = await setup();
    const omar = await env.login("outgoing");
    const lina = await env.login("incoming");
    const h = env.seed.handoverId;
    await omar.put(`/api/handovers/${h}/draft`, { revision: 1, content: orionHandover() });
    await omar.post(`/api/handovers/${h}/submit`, { attestation: true });
    assert.equal((await omar.post(`/api/handovers/${h}/approve`, {})).status, 403);
    // Lina is the assigned successor, so she learns nothing new from a 403 (vs. 404 for outsiders).
    assert.equal((await lina.put(`/api/handovers/${h}/draft`, { revision: 2, content: orionHandover() })).status, 403);
    assert.equal((await lina.post(`/api/handovers/${h}/approve`, {})).status, 403);
    assert.equal((await lina.get(`/api/handovers/${h}`)).status, 404, "but cannot read the unapproved content");
  });

  it("approved handovers are immutable", async () => {
    const env = await setup();
    const omar = await env.login("outgoing");
    const maya = await env.login("manager");
    const h = env.seed.handoverId;
    await omar.put(`/api/handovers/${h}/draft`, { revision: 1, content: orionHandover() });
    await omar.post(`/api/handovers/${h}/submit`, { attestation: true });
    await maya.post(`/api/handovers/${h}/approve`, {});
    const edit = await omar.put(`/api/handovers/${h}/draft`, { revision: 2, content: orionHandover(["tacitKnowledge"]) });
    assert.equal(edit.status, 409);
  });

  it("admins manage audit logs but do not get project content by virtue of being admin", async () => {
    const env = await setup();
    const theo = await env.login("admin");
    const maya = await env.login("manager");
    assert.equal((await theo.get(`/api/projects/${env.seed.projects.orion}`)).status, 404);
    assert.equal((await theo.get(`/api/handovers/${env.seed.handoverId}`)).status, 404);
    assert.equal((await theo.get("/api/admin/audit")).status, 200);
    assert.equal((await maya.get("/api/admin/audit")).status, 403);
  });

  it("records denied access attempts in the audit log", async () => {
    const env = await setup();
    const lina = await env.login("incoming");
    await lina.get(`/api/projects/${env.seed.projects.vega}`);
    const denied = env.s.audit.list({ limit: 200 }).filter((e) => e.outcome === "denied" && e.actorId === env.seed.users.incoming);
    assert.ok(denied.some((e) => e.action === "project.access" && e.projectId === env.seed.projects.vega));
  });

  it("uses optimistic concurrency so stale drafts cannot overwrite newer ones", async () => {
    const env = await setup();
    const omar = await env.login("outgoing");
    const res = await omar.put(`/api/handovers/${env.seed.handoverId}/draft`, { revision: 0, content: orionHandover() });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.details.currentRevision, 1);
  });
});

describe("sensitive data handling", () => {
  it("rejects drafts containing secrets, stores nothing, and audits the rejection without the secret", async () => {
    const env = await setup();
    const omar = await env.login("outgoing");
    const c = orionHandover();
    c.technical.environmentReferences = "prod db: Server=orion;User Id=svc;Password=Hunter2Hunter2;";
    const res = await omar.put(`/api/handovers/${env.seed.handoverId}/draft`, { revision: 1, content: c });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.details[0].path, "technical.environmentReferences");
    assert.ok(!res.raw.includes("Hunter2"), "secret echoed back");
    const stored = String(env.s.db.prepare("SELECT content_json FROM handovers WHERE id = ?").get(env.seed.handoverId)!.content_json);
    assert.ok(!stored.includes("Hunter2"));
    const audits = JSON.stringify(env.s.audit.list({ limit: 200 }));
    assert.ok(audits.includes("handover.secret_rejected"));
    assert.ok(!audits.includes("Hunter2"));
  });

  it("returns generic errors for unexpected failures", async () => {
    const env = await setup();
    const maya = await env.login("manager");
    const res = await maya.post("/api/handovers", { projectId: env.seed.projects.orion, outgoingUserId: "does-not-exist", transferDueDate: "2026-12-01" });
    assert.equal(res.status, 400);
    assert.doesNotMatch(res.raw, /SQLITE|stack|at \w+ \(/);
  });
});
