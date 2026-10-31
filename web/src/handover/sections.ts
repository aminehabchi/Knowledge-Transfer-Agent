import type { SectionKey } from "../types";

export type FieldKind = "text" | "textarea" | "date" | "select" | "tags";

export interface FieldDef {
  key: string;
  label: string;
  kind: FieldKind;
  options?: { value: string; label: string }[];
  hint?: string;
  required?: boolean;
  wide?: boolean;
}

export interface ListDef {
  key: string;
  label: string;
  itemNoun: string;
  titleField: string;
  fields: FieldDef[];
  hint?: string;
  required?: boolean;
}

export interface SectionDef {
  key: SectionKey;
  title: string;
  intro: string;
  fields: FieldDef[];
  lists: ListDef[];
}

const opts = (...v: [string, string][]) => v.map(([value, label]) => ({ value, label }));

const NO_SECRETS = "Reference secrets by their vault name only. Passwords, keys and tokens are rejected.";
const BUSINESS_CONTACT = "Use an approved business channel (shared mailbox, Teams channel). No personal phone numbers or home addresses.";

export const SECTIONS: SectionDef[] = [
  {
    key: "overview",
    title: "Project overview",
    intro: "What the project is, why it exists, and where it stands today.",
    fields: [
      { key: "projectSummary", label: "Project summary", kind: "textarea", required: true, wide: true },
      { key: "clientContext", label: "Client & business context", kind: "textarea", required: true },
      { key: "objectives", label: "Objectives", kind: "textarea", required: true },
      { key: "scope", label: "Scope (in and out)", kind: "textarea", required: true },
      { key: "deliverables", label: "Deliverables", kind: "textarea" },
      { key: "successCriteria", label: "Success criteria", kind: "textarea" },
      {
        key: "lifecycleStage",
        label: "Lifecycle stage",
        kind: "select",
        required: true,
        options: opts(["", "Select a stage"], ["initiation", "Initiation"], ["planning", "Planning"], ["execution", "Execution"], ["stabilisation", "Stabilisation"], ["maintenance", "Maintenance"], ["closing", "Closing"]),
      },
      { key: "currentStatus", label: "Current status", kind: "textarea", required: true, wide: true },
      { key: "architecture", label: "Architecture", kind: "textarea", required: true, wide: true, hint: "Main components, how they interact, where they run." },
      { key: "technologies", label: "Technologies", kind: "tags", hint: "Comma-separated, e.g. React, Azure SQL" },
      { key: "integrations", label: "Integrations & dependencies", kind: "textarea" },
    ],
    lists: [],
  },
  {
    key: "tasks",
    title: "Tasks & deliverables",
    intro: "Everything your successor inherits: done, in progress, pending and blocked.",
    fields: [],
    lists: [
      {
        key: "items",
        label: "Tasks",
        itemNoun: "task",
        titleField: "title",
        required: true,
        fields: [
          { key: "title", label: "Task", kind: "text", required: true, wide: true },
          { key: "status", label: "Status", kind: "select", options: opts(["pending", "Pending"], ["in_progress", "In progress"], ["blocked", "Blocked"], ["done", "Done"]) },
          { key: "priority", label: "Priority", kind: "select", options: opts(["low", "Low"], ["medium", "Medium"], ["high", "High"], ["critical", "Critical"]) },
          { key: "owner", label: "Owner", kind: "text" },
          { key: "dueDate", label: "Due date", kind: "date" },
          { key: "blockers", label: "Blockers & dependencies", kind: "textarea", wide: true },
          { key: "links", label: "Links (tickets, repos, documents)", kind: "tags", hint: "Comma-separated URLs", wide: true },
        ],
      },
    ],
  },
  {
    key: "client",
    title: "Client information",
    intro: "Requirements, how to work with the client, and what has been promised.",
    fields: [
      { key: "requirements", label: "Client requirements", kind: "textarea", required: true },
      { key: "expectations", label: "Expectations", kind: "textarea" },
      { key: "communicationProtocol", label: "Communication protocol", kind: "textarea", required: true, wide: true },
    ],
    lists: [
      {
        key: "contacts",
        label: "Authorized client contacts",
        itemNoun: "contact",
        titleField: "name",
        required: true,
        hint: BUSINESS_CONTACT,
        fields: [
          { key: "name", label: "Name or role", kind: "text", required: true },
          { key: "businessRole", label: "Business role", kind: "text" },
          { key: "channel", label: "Approved channel", kind: "text" },
          { key: "notes", label: "Notes", kind: "textarea", wide: true },
        ],
      },
      { key: "agreements", label: "Agreements, decisions & commitments", itemNoun: "agreement", titleField: "summary", fields: [{ key: "summary", label: "Agreement", kind: "textarea", required: true, wide: true }, { key: "date", label: "Date", kind: "date" }] },
      { key: "outstandingRequests", label: "Outstanding requests & follow-ups", itemNoun: "request", titleField: "summary", fields: [{ key: "summary", label: "Request", kind: "textarea", required: true, wide: true }, { key: "date", label: "Date", kind: "date" }] },
    ],
  },
  {
    key: "team",
    title: "Team & stakeholders",
    intro: "Who does what, and who to call when things go wrong.",
    fields: [
      { key: "departments", label: "Relevant internal departments", kind: "textarea" },
      { key: "escalationPath", label: "Escalation path", kind: "textarea", required: true },
    ],
    lists: [
      { key: "members", label: "Team members", itemNoun: "member", titleField: "name", required: true, fields: [{ key: "name", label: "Name", kind: "text", required: true }, { key: "responsibility", label: "Responsibility", kind: "text" }] },
      {
        key: "externalStakeholders",
        label: "External stakeholders",
        itemNoun: "stakeholder",
        titleField: "name",
        hint: BUSINESS_CONTACT,
        fields: [
          { key: "name", label: "Name or role", kind: "text", required: true },
          { key: "businessRole", label: "Role", kind: "text" },
          { key: "channel", label: "Approved channel", kind: "text" },
          { key: "notes", label: "Notes", kind: "textarea", wide: true },
        ],
      },
    ],
  },
  {
    key: "technical",
    title: "Technical & operational",
    intro: "How the system is built, deployed, monitored and fixed.",
    fields: [
      { key: "developmentProcess", label: "Development process", kind: "textarea" },
      { key: "deploymentProcedure", label: "Deployment procedure", kind: "textarea", required: true, wide: true, hint: NO_SECRETS },
      { key: "environmentReferences", label: "Environment configuration references", kind: "textarea", hint: NO_SECRETS },
      { key: "monitoring", label: "Monitoring", kind: "textarea" },
      { key: "troubleshooting", label: "Troubleshooting & common failures", kind: "textarea", required: true, wide: true },
      { key: "maintenance", label: "Maintenance procedures", kind: "textarea" },
      { key: "repositoryLinks", label: "Repository & documentation links", kind: "tags", hint: "Comma-separated URLs" },
    ],
    lists: [{ key: "knownIncidents", label: "Known incidents", itemNoun: "incident", titleField: "summary", fields: [{ key: "summary", label: "What happened", kind: "textarea", required: true, wide: true }, { key: "date", label: "Date", kind: "date" }] }],
  },
  {
    key: "risks",
    title: "Risks & undocumented knowledge",
    intro: "What could go wrong, why things are the way they are, and what isn't written down.",
    fields: [
      { key: "commonMistakes", label: "Common mistakes", kind: "textarea" },
      { key: "workarounds", label: "Workarounds", kind: "textarea" },
      { key: "technicalDebt", label: "Technical debt", kind: "textarea" },
      { key: "recommendations", label: "Recommendations for your successor", kind: "textarea", required: true, wide: true },
      { key: "tacitKnowledge", label: "Knowledge that isn't written down anywhere", kind: "textarea", required: true, wide: true, hint: "Quirks, history, unwritten rules, people's preferences that affect the work." },
    ],
    lists: [
      {
        key: "risks",
        label: "Risks",
        itemNoun: "risk",
        titleField: "description",
        required: true,
        fields: [
          { key: "description", label: "Risk", kind: "textarea", required: true, wide: true },
          { key: "impact", label: "Impact", kind: "select", options: opts(["low", "Low"], ["medium", "Medium"], ["high", "High"]) },
          { key: "mitigation", label: "Mitigation", kind: "textarea", wide: true },
        ],
      },
      {
        key: "decisions",
        label: "Important decisions",
        itemNoun: "decision",
        titleField: "decision",
        fields: [
          { key: "decision", label: "Decision", kind: "text", required: true, wide: true },
          { key: "rationale", label: "Rationale", kind: "textarea", wide: true },
          { key: "date", label: "Date", kind: "date" },
        ],
      },
      { key: "upcomingMilestones", label: "Upcoming milestones", itemNoun: "milestone", titleField: "name", fields: [{ key: "name", label: "Milestone", kind: "text", required: true }, { key: "date", label: "Date", kind: "date" }] },
    ],
  },
];

/** Blank list item with defaults matching the server schema. */
export function newItem(list: ListDef): Record<string, unknown> {
  const item: Record<string, unknown> = { id: crypto.randomUUID(), provenance: "reported", sourceRef: "" };
  for (const f of list.fields) {
    if (f.kind === "tags") item[f.key] = [];
    else if (f.kind === "select") item[f.key] = f.options?.find((o) => o.value === "medium")?.value ?? f.options?.[0]?.value ?? "";
    else item[f.key] = "";
  }
  return item;
}
