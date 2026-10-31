import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scanForSecrets } from "../../src/lib/secret-scan.ts";
import { assessCompleteness } from "../../src/modules/handover/completeness.ts";
import { renderHandoverMarkdown } from "../../src/modules/handover/render.ts";
import { emptyContent, HandoverContent } from "../../src/modules/handover/schema.ts";
import { orionHandover } from "../../src/seed/synthetic.ts";

describe("handover content validation", () => {
  it("an empty draft is valid but 0% complete with every requirement listed as missing", () => {
    const c = assessCompleteness(emptyContent());
    assert.equal(c.percent, 0);
    assert.equal(c.complete, false);
    assert.ok(c.missing.length >= 15);
    assert.ok(c.missing.every((m) => m.question.endsWith("?") || m.question.endsWith(".")));
  });

  it("a fully completed handover is 100% complete", () => {
    const c = assessCompleteness(orionHandover());
    assert.equal(c.complete, true);
    assert.equal(c.percent, 100);
  });

  it("reports exactly the omitted required fields", () => {
    const c = assessCompleteness(orionHandover(["escalationPath", "tacitKnowledge"]));
    assert.deepEqual(c.missing.map((m) => m.path).sort(), ["risks.tacitKnowledge", "team.escalationPath"]);
  });

  it("rejects 'confirmed' items without a source reference", () => {
    const res = HandoverContent.safeParse({ tasks: { items: [{ id: "x", title: "Deploy", provenance: "confirmed" }] } });
    assert.equal(res.success, false);
    assert.equal(res.error!.issues[0]!.path.join("."), "tasks.items.0.sourceRef");
  });

  it("raises quality follow-ups for ownerless tasks, undated critical tasks and blocked tasks without blockers", () => {
    const c = orionHandover();
    c.tasks.items.push({ id: "z", title: "Rotate certificates", status: "blocked", owner: "", dueDate: "", priority: "critical", blockers: "", links: [], provenance: "reported", sourceRef: "" });
    const paths = assessCompleteness(c).quality.map((q) => q.path);
    assert.ok(paths.includes("tasks.items[4].owner"));
    assert.ok(paths.includes("tasks.items[4].dueDate"));
    assert.ok(paths.includes("tasks.items[4].blockers"));
  });

  it("counts provenance labels", () => {
    const p = assessCompleteness(orionHandover()).provenance;
    assert.ok(p.confirmed >= 3 && p.reported >= 5 && p.assumption === 1 && p.open_question === 1);
  });

  it("renders every list item with its provenance tag", () => {
    const md = renderHandoverMarkdown(orionHandover(), { projectCode: "ORION", projectName: "Orion", clientName: "N", version: 1, outgoing: "O", approvedBy: "M", approvedAt: "2026-11-02" });
    assert.match(md, /Decommission legacy tracking screens.*\[Assumption - unverified\]/);
    assert.match(md, /Migrate portal authentication.*\[Confirmed\] \(source: architecture-overview\.md\)/);
    assert.match(md, /Who will own the legacy screen.*\[Open question - unresolved\]/);
  });
});

describe("secret scanning", () => {
  const cases: [string, string][] = [
    ["password: Summer2026!", "password_assignment"],
    ["Server=db;User Id=sa;Password=hunter22;", "connection_string_password"],
    ["key AKIAABCDEFGHIJKLMNOP", "aws_access_key"],
    ["-----BEGIN RSA PRIVATE KEY-----", "private_key"],
    ["use https://admin:pa55word@example.com/api", "url_credentials"],
    ["token ghp_abcdefghijklmnopqrstuvwxyz0123456789", "github_token"],
  ];
  for (const [text, kind] of cases) {
    it(`detects ${kind}`, () => {
      const findings = scanForSecrets({ technical: { environmentReferences: text } });
      assert.equal(findings.length, 1);
      assert.equal(findings[0]!.path, "technical.environmentReferences");
    });
  }

  it("allows references to secrets by name", () => {
    assert.deepEqual(scanForSecrets(orionHandover()), []);
    assert.deepEqual(scanForSecrets("The client secret is stored in Key Vault kv-orion-prod under orion-api-secret."), []);
  });
});
