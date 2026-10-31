export type HandoverStatus = "draft" | "submitted" | "changes_requested" | "approved" | "cancelled";
export type HandoverAction = "edit" | "submit" | "approve" | "request_changes" | "cancel";
export type ActorRole = "outgoing" | "manager";

interface Rule {
  from: HandoverStatus[];
  role: ActorRole;
  to: HandoverStatus | null; // null = no status change (edit)
}

const RULES: Record<HandoverAction, Rule> = {
  edit: { from: ["draft", "changes_requested"], role: "outgoing", to: null },
  submit: { from: ["draft", "changes_requested"], role: "outgoing", to: "submitted" },
  approve: { from: ["submitted"], role: "manager", to: "approved" },
  request_changes: { from: ["submitted"], role: "manager", to: "changes_requested" },
  cancel: { from: ["draft", "submitted", "changes_requested"], role: "manager", to: "cancelled" },
};

export type TransitionResult =
  | { ok: true; to: HandoverStatus }
  | { ok: false; reason: "wrong_role" | "invalid_state" };

/** Pure state machine: which role may perform which action from which status. */
export function transition(status: HandoverStatus, action: HandoverAction, roles: ReadonlySet<ActorRole>): TransitionResult {
  const rule = RULES[action];
  if (!roles.has(rule.role)) return { ok: false, reason: "wrong_role" };
  if (!rule.from.includes(status)) return { ok: false, reason: "invalid_state" };
  return { ok: true, to: rule.to ?? status };
}

export function allowedActions(status: HandoverStatus, roles: ReadonlySet<ActorRole>): HandoverAction[] {
  return (Object.keys(RULES) as HandoverAction[]).filter((a) => transition(status, a, roles).ok);
}
