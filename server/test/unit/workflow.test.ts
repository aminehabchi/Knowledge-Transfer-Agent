import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { allowedActions, transition, type ActorRole } from "../../src/modules/handover/workflow.ts";

const as = (...r: ActorRole[]) => new Set(r);

describe("handover workflow state machine", () => {
  it("lets the outgoing employee submit a draft or a returned handover", () => {
    assert.deepEqual(transition("draft", "submit", as("outgoing")), { ok: true, to: "submitted" });
    assert.deepEqual(transition("changes_requested", "submit", as("outgoing")), { ok: true, to: "submitted" });
  });

  it("only lets managers approve or request changes, and only when submitted", () => {
    assert.deepEqual(transition("submitted", "approve", as("manager")), { ok: true, to: "approved" });
    assert.deepEqual(transition("submitted", "request_changes", as("manager")), { ok: true, to: "changes_requested" });
    assert.deepEqual(transition("submitted", "approve", as("outgoing")), { ok: false, reason: "wrong_role" });
    assert.deepEqual(transition("draft", "approve", as("manager")), { ok: false, reason: "invalid_state" });
  });

  it("freezes approved and cancelled handovers", () => {
    for (const status of ["approved", "cancelled"] as const) {
      assert.deepEqual(allowedActions(status, as("outgoing", "manager")), []);
    }
  });

  it("prevents editing while under review", () => {
    assert.deepEqual(transition("submitted", "edit", as("outgoing")), { ok: false, reason: "invalid_state" });
  });

  it("lists allowed actions per role", () => {
    assert.deepEqual(allowedActions("draft", as("outgoing")), ["edit", "submit"]);
    assert.deepEqual(allowedActions("submitted", as("manager")), ["approve", "request_changes", "cancel"]);
  });
});
