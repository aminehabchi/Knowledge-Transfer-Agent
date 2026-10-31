import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEMO_CHATS, PEOPLE, seedDemoChats } from "../../src/seed/synthetic.ts";
import { setup } from "../helpers.ts";

describe("demo assistant conversations", () => {
  it("are produced by the real pipeline under each persona's own permissions", async () => {
    const env = await setup();
    const total = DEMO_CHATS.reduce((n, c) => n + c.questions.length, 0);
    assert.equal(await seedDemoChats(env.s), total);

    const history = (who: keyof typeof PEOPLE, projectId: string) => env.s.assistant.history(env.s.users.byEmail(PEOPLE[who].email)!, projectId);
    const lina = history("incoming", env.seed.projects.orion);
    assert.equal(lina.length, 5);
    assert.ok(lina[0]!.citations.some((c) => c.documentName === "deployment-runbook.md"));
    assert.ok(lina.some((a) => a.warnings.some((w) => w.kind === "withheld_source")), "injection warning shown");
    assert.ok(lina.some((a) => a.status === "insufficient_evidence" && a.suggestedContacts.length > 0));
    assert.ok(lina.every((a) => a.citations.every((c) => c.documentName !== "commercial-terms.md")), "restricted doc never cited for Lina");

    const maya = history("manager", env.seed.projects.orion);
    assert.ok(maya[0]!.citations.some((c) => c.documentName === "commercial-terms.md"), "manager is on the document ACL");

    const omar = history("outgoing", env.seed.projects.orion);
    assert.ok(omar[0]!.warnings.some((w) => w.kind === "stale_source"));

    const sam = history("otherEmployee", env.seed.projects.vega);
    assert.ok(sam[0]!.citations.every((c) => c.documentName === "vega-roadmap.md"));
  });

  it("does not duplicate conversations when run again", async () => {
    const env = await setup();
    await seedDemoChats(env.s);
    assert.equal(await seedDemoChats(env.s), 0);
  });
});
