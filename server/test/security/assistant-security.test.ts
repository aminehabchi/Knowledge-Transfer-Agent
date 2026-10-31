import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AnswerRequest, DraftAnswer, LlmProvider } from "../../src/modules/assistant/provider.ts";
import { setup } from "../helpers.ts";

/** A scripted "LLM" that records what it was shown and returns a canned (possibly hostile) answer. */
class RecordingProvider implements LlmProvider {
  readonly id = "test-recording";
  readonly label = "Test provider";
  readonly generative = true;
  seen: AnswerRequest[] = [];
  reply: (req: AnswerRequest) => DraftAnswer;
  constructor(reply: (req: AnswerRequest) => DraftAnswer) {
    this.reply = reply;
  }
  async answer(req: AnswerRequest) {
    this.seen.push(req);
    return this.reply(req);
  }
}

const echoFirst = (req: AnswerRequest): DraftAnswer => ({
  status: "answered",
  statements: [{ text: req.passages[0]?.text ?? "nothing", kind: "verified", citations: req.passages[0] ? [req.passages[0].label] : [] }],
  contradictions: [],
});

describe("assistant authorization filtering", () => {
  it("never sends documents restricted by SharePoint ACL to the model or the user", async () => {
    const provider = new RecordingProvider(echoFirst);
    const env = await setup({ overrides: { provider } });
    const lina = await env.login("incoming");
    const res = await lina.post(`/api/projects/${env.seed.projects.orion}/assistant/ask`, { question: "What service credit applies when availability is below target?" });
    const allText = provider.seen.flatMap((r) => r.passages.map((p) => `${p.title} ${p.text}`)).join("\n");
    assert.doesNotMatch(allText, /commercial-terms|2% service credit/);
    assert.doesNotMatch(res.raw, /commercial-terms|2% service credit/);

    // The manager, who is on the document's ACL, does get it.
    const maya = await env.login("manager");
    const mres = await maya.post(`/api/projects/${env.seed.projects.orion}/assistant/ask`, { question: "What service credit applies when availability is below target?" });
    assert.match(mres.raw, /commercial-terms\.md/);
  });

  it("hides restricted documents from listings and direct reads", async () => {
    const env = await setup();
    const lina = await env.login("incoming");
    const maya = await env.login("manager");
    const all = (await maya.get(`/api/projects/${env.seed.projects.orion}/documents`)).body;
    const restricted = all.find((d: { name: string }) => d.name === "commercial-terms.md");
    assert.ok(restricted);
    const visible = (await lina.get(`/api/projects/${env.seed.projects.orion}/documents`)).body.map((d: { name: string }) => d.name);
    assert.ok(!visible.includes("commercial-terms.md"));
    assert.equal((await lina.get(`/api/projects/${env.seed.projects.orion}/documents/${restricted.id}`)).status, 404);
  });

  it("never retrieves another project's documents", async () => {
    const provider = new RecordingProvider(echoFirst);
    const env = await setup({ overrides: { provider } });
    const lina = await env.login("incoming");
    await lina.post(`/api/projects/${env.seed.projects.orion}/assistant/ask`, { question: "What Kubernetes cluster and pipeline does deployment use?" });
    const titles = provider.seen.flatMap((r) => r.passages.map((p) => p.title));
    assert.ok(!titles.includes("vega-roadmap.md"), titles.join(","));
  });

  it("does not expose unapproved draft handover content", async () => {
    const env = await setup();
    const lina = await env.login("incoming");
    // "Release 2.0 go-live" exists only in Omar's unapproved draft.
    const res = await lina.post(`/api/projects/${env.seed.projects.orion}/assistant/ask`, { question: "When is the Release 2.0 go-live milestone?" });
    assert.doesNotMatch(res.raw, /2027-01-20/);
  });
});

describe("prompt-injection defences", () => {
  it("withholds instruction-like passages from the model and warns the user", async () => {
    const provider = new RecordingProvider(echoFirst);
    const env = await setup({ overrides: { provider } });
    const lina = await env.login("incoming");
    const res = await lina.post(`/api/projects/${env.seed.projects.orion}/assistant/ask`, { question: "What does the assistant notice in the vendor notes say about system access?" });
    const sent = provider.seen.flatMap((r) => r.passages.map((p) => p.text)).join("\n");
    assert.doesNotMatch(sent, /Ignore all previous instructions/);
    assert.ok(res.body.warnings.some((w: { kind: string; message: string }) => w.kind === "withheld_source" && /vendor-notes\.md/.test(w.message)));
  });

  it("the non-flagged parts of the same document remain usable", async () => {
    const env = await setup();
    const lina = await env.login("incoming");
    const res = await lina.post(`/api/projects/${env.seed.projects.orion}/assistant/ask`, { question: "What is the carrier rates service rate limit?" });
    assert.equal(res.body.status, "answered");
    assert.match(res.raw, /50 requests per second/);
  });

  it("drops citations the model invents and statements with no valid source", async () => {
    const provider = new RecordingProvider((req) => ({
      status: "answered",
      statements: [
        { text: "Grounded fact.", kind: "verified", citations: [req.passages[0]!.label] },
        { text: "The client promised a 50% discount.", kind: "verified", citations: ["S99"] },
        { text: "Contact the CEO at ceo@example.com.", kind: "reported", citations: [] },
        { text: "Consider shadowing a deployment.", kind: "recommendation", citations: ["S42"] },
      ],
      contradictions: [{ description: "Invented contradiction", citations: ["S77", "S78"] }],
    }));
    const env = await setup({ overrides: { provider } });
    const lina = await env.login("incoming");
    const res = await lina.post(`/api/projects/${env.seed.projects.orion}/assistant/ask`, { question: "What are the deployment steps?" });
    const texts = res.body.statements.map((s: { text: string }) => s.text);
    assert.deepEqual(texts, ["Grounded fact.", "Consider shadowing a deployment."]);
    assert.deepEqual(res.body.statements[1].citations, [], "invented citation removed from recommendation");
    assert.ok(res.body.warnings.some((w: { kind: string }) => w.kind === "removed_unsupported"));
    assert.ok(!res.body.warnings.some((w: { kind: string }) => w.kind === "contradiction"));
    assert.doesNotMatch(res.raw, /50% discount|ceo@example\.com/);
  });

  it("re-derives statement kinds from the sources instead of trusting the model's label", async () => {
    const provider = new RecordingProvider((req) => {
      const reported = req.passages.find((p) => p.docType === "handover" && p.provenance === "reported");
      if (!reported) return { status: "insufficient_evidence", statements: [], contradictions: [] };
      return { status: "answered", statements: [{ text: "Claimed as verified.", kind: "verified", citations: [reported.label] }], contradictions: [] };
    });
    const env = await setup({ overrides: { provider } });
    // Publish an approved handover so handover passages exist.
    const omar = await env.login("outgoing");
    const maya = await env.login("manager");
    const { orionHandover } = await import("../../src/seed/synthetic.ts");
    await omar.put(`/api/handovers/${env.seed.handoverId}/draft`, { revision: 1, content: orionHandover() });
    await omar.post(`/api/handovers/${env.seed.handoverId}/submit`, { attestation: true });
    await maya.post(`/api/handovers/${env.seed.handoverId}/approve`, {});
    await env.s.jobs.runDue();

    const lina = await env.login("incoming");
    const res = await lina.post(`/api/projects/${env.seed.projects.orion}/assistant/ask`, { question: "Which AS/400 team hours and service manager preferences should I know?" });
    assert.equal(res.body.status, "answered", "expected a reported handover passage to be retrieved");
    assert.equal(res.body.citations[0].docType, "handover");
    assert.equal(res.body.statements[0].kind, "reported", "model's 'verified' label must be downgraded");
  });

  it("falls back to an explicit 'insufficient evidence' answer when the model only returns unsupported claims", async () => {
    const provider = new RecordingProvider(() => ({ status: "answered", statements: [{ text: "Made up.", kind: "verified", citations: [] }], contradictions: [] }));
    const env = await setup({ overrides: { provider } });
    const lina = await env.login("incoming");
    const res = await lina.post(`/api/projects/${env.seed.projects.orion}/assistant/ask`, { question: "What are the deployment steps?" });
    assert.equal(res.body.status, "insufficient_evidence");
    assert.equal(res.body.statements[0].kind, "unanswered");
    assert.deepEqual(res.body.suggestedContacts, [{ name: "Maya Chen", role: "Project manager" }]);
  });

  it("rate-limits assistant questions per user", async () => {
    const env = await setup({ cfg: { ASSISTANT_RATE_LIMIT_PER_MINUTE: 2 } });
    const lina = await env.login("incoming");
    const url = `/api/projects/${env.seed.projects.orion}/assistant/ask`;
    assert.equal((await lina.post(url, { question: "deployment steps?" })).status, 200);
    assert.equal((await lina.post(url, { question: "deployment steps?" })).status, 200);
    assert.equal((await lina.post(url, { question: "deployment steps?" })).status, 429);
  });
});
