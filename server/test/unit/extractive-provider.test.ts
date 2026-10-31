import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ExtractiveProvider } from "../../src/modules/assistant/extractive-provider.ts";
import type { SourcePassage } from "../../src/modules/assistant/provider.ts";

const passage = (label: string, heading: string, text: string, extra: Partial<SourcePassage> = {}): SourcePassage => ({
  label, title: "doc.md", heading, docType: "project_document", provenance: null, stale: false, text, ...extra,
});

describe("extractive provider (no LLM)", () => {
  const p = new ExtractiveProvider();

  it("returns the lines of a matching section in source order", async () => {
    const steps = passage("S1", "Deployment steps", "1. Merge the release branch after CAB approval.\n2. The pipeline deploys to the staging slot.\n3. Swap the staging slot into production.");
    const res = await p.answer({ question: "What are the deployment steps?", projectName: "X", passages: [steps] });
    assert.equal(res.status, "answered");
    assert.deepEqual(res.statements.map((s) => s.text.slice(0, 12)), ["Merge the re", "The pipeline", "Swap the sta"]);
    assert.ok(res.statements.every((s) => s.kind === "verified" && s.citations[0] === "S1"));
  });

  it("labels handover statements as reported unless confirmed", async () => {
    const res = await p.answer({
      question: "Who owns the Sync Worker timeout fix?",
      projectName: "X",
      passages: [passage("S1", "Tasks", "- Fix Sync Worker timeout - owner: Lina Park [Reported by outgoing employee]", { docType: "handover", provenance: "reported" })],
    });
    assert.equal(res.statements[0]!.kind, "reported");
    assert.doesNotMatch(res.statements[0]!.text, /\[Reported/, "provenance tags are stripped from quoted text");
  });

  it("reports insufficient evidence instead of guessing", async () => {
    const res = await p.answer({ question: "What is the parking policy?", projectName: "X", passages: [passage("S1", "Deployment", "Swap the slots on Wednesday.")] });
    assert.equal(res.status, "insufficient_evidence");
    assert.deepEqual(res.statements, []);
  });

  it("never produces recommendations or contradictions (it cannot synthesise)", async () => {
    const res = await p.answer({ question: "deployment", projectName: "X", passages: [passage("S1", "Deployment", "Deployment happens weekly.")] });
    assert.ok(res.statements.every((s) => s.kind !== "recommendation"));
    assert.deepEqual(res.contradictions, []);
  });
});
