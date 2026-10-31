import type { HandoverContent, SectionKey } from "./schema.ts";

interface Requirement {
  section: SectionKey;
  path: string;
  label: string;
  /** Focused follow-up question asked by the interview when this field is missing. */
  question: string;
  present: (c: HandoverContent) => boolean;
}

const filled = (s: string) => s.trim().length >= 3;

export const REQUIREMENTS: Requirement[] = [
  { section: "overview", path: "overview.projectSummary", label: "Project summary", question: "In two or three sentences, what does this project deliver and for whom?", present: (c) => filled(c.overview.projectSummary) },
  { section: "overview", path: "overview.clientContext", label: "Client & business context", question: "What business problem is the client solving with this project, and why does it matter to them now?", present: (c) => filled(c.overview.clientContext) },
  { section: "overview", path: "overview.objectives", label: "Objectives", question: "What are the project's objectives and how will success be measured?", present: (c) => filled(c.overview.objectives) },
  { section: "overview", path: "overview.scope", label: "Scope", question: "What is explicitly in scope and out of scope?", present: (c) => filled(c.overview.scope) },
  { section: "overview", path: "overview.lifecycleStage", label: "Lifecycle stage", question: "Which lifecycle stage is the project in today?", present: (c) => c.overview.lifecycleStage !== "" },
  { section: "overview", path: "overview.currentStatus", label: "Current status", question: "What is the current status - what is on track, late, or at risk?", present: (c) => filled(c.overview.currentStatus) },
  { section: "overview", path: "overview.architecture", label: "Architecture", question: "Describe the main components, how they interact, and where they run.", present: (c) => filled(c.overview.architecture) },
  { section: "tasks", path: "tasks.items", label: "Tasks", question: "List the in-progress and pending tasks your successor will inherit, with owners and deadlines.", present: (c) => c.tasks.items.length > 0 },
  { section: "client", path: "client.requirements", label: "Client requirements", question: "What are the client's key requirements and non-negotiables?", present: (c) => filled(c.client.requirements) },
  { section: "client", path: "client.communicationProtocol", label: "Communication protocol", question: "How and how often does the team communicate with the client (meetings, channels, reporting)?", present: (c) => filled(c.client.communicationProtocol) },
  { section: "client", path: "client.contacts", label: "Authorized client contacts", question: "Who are the authorized client contacts, what are their business roles, and which approved channel should be used?", present: (c) => c.client.contacts.length > 0 },
  { section: "team", path: "team.members", label: "Team members", question: "Who is on the team and what is each person responsible for?", present: (c) => c.team.members.length > 0 },
  { section: "team", path: "team.escalationPath", label: "Escalation path", question: "Who should be contacted, and in what order, when something goes wrong?", present: (c) => filled(c.team.escalationPath) },
  { section: "technical", path: "technical.deploymentProcedure", label: "Deployment procedure", question: "Walk through how a change gets deployed to production, step by step. Reference secrets by their vault name only.", present: (c) => filled(c.technical.deploymentProcedure) },
  { section: "technical", path: "technical.troubleshooting", label: "Troubleshooting", question: "What are the most common failures and how do you diagnose and fix them?", present: (c) => filled(c.technical.troubleshooting) },
  { section: "risks", path: "risks.risks", label: "Risks", question: "What are the main risks to the project and how are they being mitigated?", present: (c) => c.risks.risks.length > 0 },
  { section: "risks", path: "risks.recommendations", label: "Recommendations", question: "What should your successor focus on first, and what would you do differently?", present: (c) => filled(c.risks.recommendations) },
  { section: "risks", path: "risks.tacitKnowledge", label: "Undocumented knowledge", question: "What do you know that is not written down anywhere - quirks, history, unwritten rules?", present: (c) => filled(c.risks.tacitKnowledge) },
];

export interface QualityIssue {
  path: string;
  severity: "warning";
  message: string;
  question: string;
}

/** Non-blocking checks that produce targeted follow-up questions. */
export function qualityIssues(c: HandoverContent): QualityIssue[] {
  const issues: QualityIssue[] = [];
  c.tasks.items.forEach((t, i) => {
    if (t.status !== "done" && !filled(t.owner)) {
      issues.push({ path: `tasks.items[${i}].owner`, severity: "warning", message: `Task "${t.title}" has no owner`, question: `Who will own "${t.title}" after you leave?` });
    }
    if ((t.priority === "high" || t.priority === "critical") && t.status !== "done" && !t.dueDate) {
      issues.push({ path: `tasks.items[${i}].dueDate`, severity: "warning", message: `High-priority task "${t.title}" has no deadline`, question: `When is "${t.title}" due, and who agreed that date?` });
    }
    if (t.status === "blocked" && !filled(t.blockers)) {
      issues.push({ path: `tasks.items[${i}].blockers`, severity: "warning", message: `Blocked task "${t.title}" has no blocker description`, question: `What is blocking "${t.title}" and who can unblock it?` });
    }
  });
  c.risks.decisions.forEach((d, i) => {
    if (!filled(d.rationale)) {
      issues.push({ path: `risks.decisions[${i}].rationale`, severity: "warning", message: `Decision "${d.decision}" has no rationale`, question: `Why was "${d.decision}" decided, and what alternatives were rejected?` });
    }
  });
  const assumptions = countByProvenance(c).assumption;
  if (assumptions > 0) {
    issues.push({ path: "", severity: "warning", message: `${assumptions} item(s) are marked as assumptions`, question: "Can any of the items marked as assumptions be confirmed with a source document?" });
  }
  return issues;
}

export function countByProvenance(c: HandoverContent) {
  const counts = { confirmed: 0, reported: 0, assumption: 0, open_question: 0 };
  const lists = [c.tasks.items, c.client.contacts, c.client.agreements, c.client.outstandingRequests, c.team.members, c.team.externalStakeholders, c.technical.knownIncidents, c.risks.risks, c.risks.decisions, c.risks.upcomingMilestones];
  for (const list of lists) for (const it of list) counts[it.provenance]++;
  counts.open_question += c.openQuestions.length;
  return counts;
}

export interface Completeness {
  percent: number;
  complete: boolean;
  missing: { section: SectionKey; path: string; label: string; question: string }[];
  bySection: Record<SectionKey, { required: number; present: number }>;
  quality: QualityIssue[];
  provenance: ReturnType<typeof countByProvenance>;
}

export function assessCompleteness(c: HandoverContent): Completeness {
  const bySection = {} as Completeness["bySection"];
  const missing: Completeness["missing"] = [];
  for (const r of REQUIREMENTS) {
    const s = (bySection[r.section] ??= { required: 0, present: 0 });
    s.required++;
    if (r.present(c)) s.present++;
    else missing.push({ section: r.section, path: r.path, label: r.label, question: r.question });
  }
  const present = REQUIREMENTS.length - missing.length;
  return {
    percent: Math.round((present / REQUIREMENTS.length) * 100),
    complete: missing.length === 0,
    missing,
    bySection,
    quality: qualityIssues(c),
    provenance: countByProvenance(c),
  };
}
