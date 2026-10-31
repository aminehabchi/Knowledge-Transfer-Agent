import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MockDocumentRepository } from "../../src/modules/sharepoint/mock-adapter.ts";
import { IntegrationError } from "../../src/modules/sharepoint/types.ts";
import { orionHandover } from "../../src/seed/synthetic.ts";
import { setup, type TestEnv } from "../helpers.ts";

async function approveSeededHandover(env: TestEnv) {
  const omar = await env.login("outgoing");
  const maya = await env.login("manager");
  await omar.put(`/api/handovers/${env.seed.handoverId}/draft`, { revision: 1, content: orionHandover() });
  await omar.post(`/api/handovers/${env.seed.handoverId}/submit`, { attestation: true });
  const res = await maya.post(`/api/handovers/${env.seed.handoverId}/approve`, {});
  assert.equal(res.status, 200, res.raw);
  return maya;
}

const handoverItems = (env: TestEnv) =>
  env.s.db.prepare("SELECT path, version FROM mock_sharepoint_items WHERE path LIKE 'ORION/01-Handover/%'").all();

describe("SharePoint publication", () => {
  it("retries transient failures and publishes exactly one document", async () => {
    const env = await setup();
    const mock = env.s.repo as MockDocumentRepository;
    const maya = await approveSeededHandover(env);
    mock.injectFaults(2, new IntegrationError("Microsoft Graph throttled", { retryable: true, status: 429 }));

    await env.s.jobs.runDue();
    let h = (await maya.get(`/api/handovers/${env.seed.handoverId}`)).body;
    assert.equal(h.publication.status, "pending");
    assert.match(h.publication.lastError, /throttled/);

    env.clock.advance(31_000);
    await env.s.jobs.runDue();
    env.clock.advance(61_000);
    await env.s.jobs.runDue();
    h = (await maya.get(`/api/handovers/${env.seed.handoverId}`)).body;
    assert.equal(h.publication.status, "synced");
    assert.equal(h.publication.attempts, 3);
    assert.equal(handoverItems(env).length, 1, "no duplicate documents after retries");
  });

  it("marks permanent failures as failed, shows them in integration health, and lets a manager retry", async () => {
    const env = await setup();
    const mock = env.s.repo as MockDocumentRepository;
    const maya = await approveSeededHandover(env);
    mock.injectFaults(1, new IntegrationError("Microsoft Graph permission denied (HTTP 403)", { retryable: false, status: 403 }));
    await env.s.jobs.runDue();

    const h = (await maya.get(`/api/handovers/${env.seed.handoverId}`)).body;
    assert.equal(h.publication.status, "failed");
    const health = (await maya.get("/api/integrations/health")).body;
    assert.equal(health.publications.failed, 1);
    assert.equal(health.sharepoint.simulated, true);
    assert.equal(handoverItems(env).length, 0, "nothing claimed as published");

    const omar = await env.login("outgoing");
    assert.equal((await omar.post(`/api/handovers/${env.seed.handoverId}/retry-publication`)).status, 403);
    assert.equal((await maya.post(`/api/handovers/${env.seed.handoverId}/retry-publication`)).status, 200);
    await env.s.jobs.runDue();
    assert.equal((await maya.get(`/api/handovers/${env.seed.handoverId}`)).body.publication.status, "synced");
    assert.equal((await maya.post(`/api/handovers/${env.seed.handoverId}/retry-publication`)).status, 409);
  });

  it("re-running the publish job for a synced version is a no-op", async () => {
    const env = await setup();
    await approveSeededHandover(env);
    await env.s.jobs.runDue();
    env.s.jobs.enqueue("sharepoint.publish_handover", { handoverId: env.seed.handoverId, version: 1 });
    await env.s.jobs.runDue();
    const items = handoverItems(env);
    assert.equal(items.length, 1);
    assert.equal(items[0]!.version, 1, "not re-uploaded");
  });
});

describe("document ingestion", () => {
  it("indexes text documents, reports unsupported formats, and records ACLs and injection flags", async () => {
    const env = await setup();
    const maya = await env.login("manager");
    const docs = (await maya.get(`/api/projects/${env.seed.projects.orion}/documents`)).body as { name: string; ingestStatus: string; flaggedChunks: number }[];
    const byName = Object.fromEntries(docs.map((d) => [d.name, d]));
    assert.equal(byName["deployment-runbook.md"]!.ingestStatus, "indexed");
    assert.equal(byName["team-charter.docx"]!.ingestStatus, "unsupported_format");
    assert.ok(byName["vendor-notes.md"]!.flaggedChunks >= 1);
    assert.ok(byName["commercial-terms.md"], "manager is on the ACL");
  });

  it("flags stale sources in answers", async () => {
    const env = await setup();
    const lina = await env.login("incoming");
    const res = await lina.post(`/api/projects/${env.seed.projects.orion}/assistant/ask`, { question: "When does the legacy export job run relative to the Sync Worker?" });
    assert.ok(res.body.warnings.some((w: { kind: string }) => w.kind === "stale_source"), res.raw);
    assert.ok(res.body.citations.some((c: { stale: boolean; documentName: string }) => c.stale && c.documentName === "legacy-integration-notes.md"));
  });

  it("removes documents deleted from SharePoint and skips unchanged ones", async () => {
    const env = await setup();
    env.s.db.prepare("DELETE FROM mock_sharepoint_items WHERE path = 'ORION/02-Project-Documents/vendor-notes.md'").run();
    const report = await env.s.index.ingestProject(env.seed.projects.orion);
    assert.equal(report.removed, 1);
    assert.equal(report.indexed, 0);
    assert.ok(report.unchanged >= 5);
  });

  it("re-reads ACL changes even when content is unchanged", async () => {
    const env = await setup();
    const lina = await env.login("incoming");
    env.s.db.prepare("UPDATE mock_sharepoint_items SET acl_json = ? WHERE path = 'ORION/02-Project-Documents/deployment-runbook.md'").run(JSON.stringify(["maya.chen@example.com"]));
    await env.s.index.ingestProject(env.seed.projects.orion);
    const names = (await lina.get(`/api/projects/${env.seed.projects.orion}/documents`)).body.map((d: { name: string }) => d.name);
    assert.ok(!names.includes("deployment-runbook.md"));
  });

  it("only the latest approved handover version is searchable", async () => {
    const env = await setup();
    const mock = env.s.repo as MockDocumentRepository;
    mock.seed("ORION", "handover", "ORION-handover-v1.md", "# Old\n\n## Status\n\nThe zeppelin integration is live.");
    mock.seed("ORION", "handover", "ORION-handover-v2.md", "# New\n\n## Status\n\nThe zeppelin integration was retired.");
    await env.s.index.ingestProject(env.seed.projects.orion);
    const lina = await env.login("incoming");
    const res = await lina.post(`/api/projects/${env.seed.projects.orion}/assistant/ask`, { question: "Is the zeppelin integration live?" });
    assert.match(res.raw, /retired/);
    assert.doesNotMatch(res.raw, /is live/);
  });
});
