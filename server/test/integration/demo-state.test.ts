import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { orionHandover } from "../../src/seed/synthetic.ts";
import { setup } from "../helpers.ts";

describe("demo presenter state", () => {
  it("tracks the ORION story without exposing handover content", async () => {
    const env = await setup();
    const lina = await env.login("incoming");
    let st = (await lina.get("/api/demo/state")).body;
    assert.equal(st.handoverStatus, "draft");
    assert.equal(st.publicationStatus, null);
    assert.ok(!JSON.stringify(st).includes("Northwind"), "no content leaks");

    const omar = await env.login("outgoing");
    const maya = await env.login("manager");
    await omar.put(`/api/handovers/${env.seed.handoverId}/draft`, { revision: 1, content: orionHandover() });
    await omar.post(`/api/handovers/${env.seed.handoverId}/submit`, { attestation: true });
    env.clock.advance(1000);
    await maya.post(`/api/handovers/${env.seed.handoverId}/approve`, {});
    await env.s.jobs.runDue();
    env.clock.advance(1000);
    await lina.post(`/api/projects/${env.seed.projects.orion}/assistant/ask`, { question: "What are the deployment steps?" });

    st = (await lina.get("/api/demo/state")).body;
    assert.deepEqual([st.handoverStatus, st.publicationStatus, st.askedAfterApproval], ["approved", "synced", true]);
  });

  it("is unavailable outside demo mode", async () => {
    const env = await setup({
      cfg: { AUTH_MODE: "entra", ENTRA_TENANT_ID: "t", ENTRA_CLIENT_ID: "c", ENTRA_CLIENT_SECRET: "s", ENTRA_REDIRECT_URI: "http://localhost/cb" },
      seed: false,
    });
    const res = await env.app.inject({ method: "GET", url: "/api/demo/state" });
    assert.equal(res.statusCode, 401);
  });
});
