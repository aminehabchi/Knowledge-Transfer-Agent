import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { orionHandover } from "../../src/seed/synthetic.ts";
import { setup } from "../helpers.ts";

/**
 * Full lifecycle over the HTTP API (demo auth, MOCK SharePoint, extractive assistant):
 * assignment → capture → submit → review → approve → publish to SharePoint → ingest → grounded answer.
 */
describe("end-to-end handover lifecycle", () => {
  it("runs from assignment to a source-cited answer for the incoming employee", async () => {
    const env = await setup();
    const maya = await env.login("manager");
    const omar = await env.login("outgoing");
    const lina = await env.login("incoming");

    // 1. Manager creates a project and a handover assignment.
    const project = await maya.post("/api/projects", { code: "ATLAS", name: "Atlas Billing", clientName: "Contoso Freight (synthetic)" });
    assert.equal(project.status, 200, project.raw);
    const assignment = await maya.post("/api/handovers", {
      projectId: project.body.id,
      outgoingUserId: env.seed.users.outgoing,
      incomingUserId: env.seed.users.incoming,
      transferDueDate: "2026-11-20",
      onboardingStartDate: "2026-11-23",
    });
    assert.equal(assignment.status, 200, assignment.raw);
    const id = assignment.body.id;
    assert.equal(assignment.body.status, "draft");

    // The incoming employee cannot see an unapproved handover.
    assert.equal((await lina.get(`/api/handovers/${id}`)).status, 404);

    // 2. Outgoing employee captures knowledge; the interview asks for missing fields; then submits.
    const interview0 = await omar.get(`/api/handovers/${id}/interview`);
    assert.ok(interview0.body.questions.length >= 15);
    const partial = orionHandover(["tacitKnowledge"]);
    let save = await omar.put(`/api/handovers/${id}/draft`, { revision: 0, content: partial });
    assert.equal(save.status, 200, save.raw);
    assert.equal(save.body.completeness.complete, false);
    const early = await omar.post(`/api/handovers/${id}/submit`, { attestation: true });
    assert.equal(early.status, 422);
    assert.equal(early.body.error.details[0].path, "risks.tacitKnowledge");

    const interview1 = await omar.get(`/api/handovers/${id}/interview`);
    assert.equal(interview1.body.questions[0].path, "risks.tacitKnowledge");

    save = await omar.put(`/api/handovers/${id}/draft`, { revision: 1, content: orionHandover() });
    assert.equal(save.body.completeness.percent, 100);
    const submitted = await omar.post(`/api/handovers/${id}/submit`, { attestation: true });
    assert.equal(submitted.status, 200, submitted.raw);
    assert.equal(submitted.body.status, "submitted");
    assert.equal(submitted.body.currentVersion, 1);
    assert.ok(submitted.body.authorAttestedAt);

    // 3. Manager requests a revision, outgoing fixes it, manager approves.
    const returned = await maya.post(`/api/handovers/${id}/request-changes`, { comment: "Please add the CSV export deadline." });
    assert.equal(returned.body.status, "changes_requested");
    const fixed = orionHandover();
    fixed.client.outstandingRequests[0]!.summary = "Northwind asked for a CSV export of shipment history by 2027-01-10.";
    save = await omar.put(`/api/handovers/${id}/draft`, { revision: 2, content: fixed });
    assert.equal(save.status, 200, save.raw);
    await omar.post(`/api/handovers/${id}/submit`, { attestation: true });
    const approved = await maya.post(`/api/handovers/${id}/approve`, { comment: "Thorough, thank you." });
    assert.equal(approved.status, 200, approved.raw);
    assert.equal(approved.body.status, "approved");
    assert.equal(approved.body.approvedVersion, 2);
    assert.equal(approved.body.publication.status, "pending");

    // 4. Background jobs publish to (mock) SharePoint and index the project.
    await env.s.jobs.runDue();
    const after = await maya.get(`/api/handovers/${id}`);
    assert.equal(after.body.publication.status, "synced");
    assert.equal(after.body.publication.adapterMode, "mock");
    assert.equal(after.body.publication.remotePath, "ATLAS/01-Handover/ATLAS-handover-v2.md");
    assert.equal(after.body.versions.length, 2);
    assert.equal(after.body.versions[1].decision, "changes_requested");

    // 5. The incoming employee now sees only the approved, immutable version.
    const view = await lina.get(`/api/handovers/${id}`);
    assert.equal(view.status, 200);
    assert.equal(view.body.content, null);
    assert.equal(view.body.submittedContent, null);
    assert.match(view.body.approvedContent.client.outstandingRequests[0].summary, /2027-01-10/);
    assert.deepEqual(view.body.allowedActions, []);

    // 6. The assistant answers with a citation to the published handover.
    const ask = await lina.post(`/api/projects/${project.body.id}/assistant/ask`, { question: "When is the CSV export of shipment history due?" });
    assert.equal(ask.status, 200, ask.raw);
    assert.equal(ask.body.status, "answered");
    const stmt = ask.body.statements.find((s: { text: string }) => /CSV export/.test(s.text));
    assert.ok(stmt, JSON.stringify(ask.body.statements));
    assert.equal(stmt.kind, "reported", "handover statements are labelled as reported by the outgoing employee");
    const cite = ask.body.citations.find((c: { label: string }) => c.label === stmt.citations[0]);
    assert.equal(cite.documentName, "ATLAS-handover-v2.md");
    assert.equal(cite.simulatedSource, true);
    assert.equal(cite.webUrl, null, "mock sources never pretend to have a SharePoint URL");

    // The cited document is readable by the incoming employee through the authorised viewer.
    const doc = await lina.get(`/api/projects/${project.body.id}/documents/${cite.documentId}`);
    assert.equal(doc.status, 200);

    // Audit trail captured the key events.
    const actions = env.s.audit.list({ projectId: project.body.id, limit: 100 }).map((e) => e.action);
    for (const a of ["handover.assign", "handover.submit", "handover.request_changes", "handover.approve", "sharepoint.publish", "retrieval.ingest", "assistant.ask"]) {
      assert.ok(actions.includes(a), `missing audit event ${a}`);
    }
  });

  it("answers from verified project documents in the seeded demo project", async () => {
    const env = await setup();
    const lina = await env.login("incoming");
    const ask = await lina.post(`/api/projects/${env.seed.projects.orion}/assistant/ask`, { question: "What are the deployment steps?" });
    assert.equal(ask.body.status, "answered");
    const verified = ask.body.statements.filter((s: { kind: string }) => s.kind === "verified");
    assert.ok(verified.length > 0);
    const docs = new Set(ask.body.citations.map((c: { documentName: string }) => c.documentName));
    assert.ok(docs.has("deployment-runbook.md"), [...docs].join(","));
  });

  it("says when evidence is missing and points to the project manager instead of guessing", async () => {
    const env = await setup();
    const lina = await env.login("incoming");
    const ask = await lina.post(`/api/projects/${env.seed.projects.orion}/assistant/ask`, { question: "What is the parking policy at the Lisbon office?" });
    assert.equal(ask.body.status, "insufficient_evidence");
    assert.equal(ask.body.statements[0].kind, "unanswered");
    assert.deepEqual(ask.body.suggestedContacts, [{ name: "Maya Chen", role: "Project manager" }]);
  });
});
