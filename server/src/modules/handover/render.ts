import type { HandoverContent, Provenance } from "./schema.ts";

export const PROVENANCE_TAG: Record<Provenance, string> = {
  confirmed: "[Confirmed]",
  reported: "[Reported by outgoing employee]",
  assumption: "[Assumption - unverified]",
  open_question: "[Open question - unresolved]",
};

export interface RenderMeta {
  projectCode: string;
  projectName: string;
  clientName: string;
  version: number;
  outgoing: string;
  approvedBy: string;
  approvedAt: string;
}

const esc = (s: string) => s.replace(/\r/g, "").trim();
const para = (label: string, value: string) => (value.trim() ? `**${label}:** ${esc(value)}\n\n` : "");
const tag = (p: Provenance, sourceRef: string) => `${PROVENANCE_TAG[p]}${sourceRef ? ` (source: ${sourceRef})` : ""}`;

/**
 * Renders an approved handover as Markdown. Headings are chunk boundaries for retrieval and every
 * list item carries its provenance tag so answers can distinguish verified vs reported knowledge.
 * Narrative fields are written by the outgoing employee and are labelled as reported.
 */
export function renderHandoverMarkdown(c: HandoverContent, m: RenderMeta): string {
  let md = `# Handover: ${m.projectName} (${m.projectCode}) - version ${m.version}\n\n`;
  md += `Client: ${m.clientName}  \nOutgoing employee: ${m.outgoing}  \nApproved by: ${m.approvedBy} on ${m.approvedAt}\n\n`;
  md += `> Narrative sections are ${PROVENANCE_TAG.reported} unless an item states otherwise.\n\n`;

  md += `## Project overview\n\n`;
  md += para("Summary", c.overview.projectSummary) + para("Client and business context", c.overview.clientContext);
  md += para("Objectives", c.overview.objectives) + para("Scope", c.overview.scope) + para("Deliverables", c.overview.deliverables);
  md += para("Success criteria", c.overview.successCriteria) + para("Lifecycle stage", c.overview.lifecycleStage);
  md += para("Current status", c.overview.currentStatus);
  md += `## Architecture and technologies\n\n`;
  md += para("Architecture", c.overview.architecture) + para("Technologies", c.overview.technologies.join(", ")) + para("Integrations and dependencies", c.overview.integrations);

  md += `## Tasks and deliverables\n\n`;
  for (const t of c.tasks.items) {
    md += `- **${esc(t.title)}** - status: ${t.status}; priority: ${t.priority}; owner: ${esc(t.owner) || "unassigned"}; due: ${t.dueDate || "not set"}`;
    if (t.blockers) md += `; blockers: ${esc(t.blockers)}`;
    if (t.links.length) md += `; links: ${t.links.join(", ")}`;
    md += ` ${tag(t.provenance, t.sourceRef)}\n`;
  }
  md += `\n## Client information\n\n`;
  md += para("Requirements", c.client.requirements) + para("Expectations", c.client.expectations) + para("Communication protocol", c.client.communicationProtocol);
  if (c.client.contacts.length) md += `Authorized client contacts:\n\n`;
  for (const p of c.client.contacts) md += `- ${esc(p.name)} - ${esc(p.businessRole)}${p.channel ? `; channel: ${esc(p.channel)}` : ""}${p.notes ? `; ${esc(p.notes)}` : ""} ${tag(p.provenance, p.sourceRef)}\n`;
  if (c.client.agreements.length) md += `\nAgreements and commitments:\n\n`;
  for (const a of c.client.agreements) md += `- ${esc(a.summary)}${a.date ? ` (${a.date})` : ""} ${tag(a.provenance, a.sourceRef)}\n`;
  if (c.client.outstandingRequests.length) md += `\nOutstanding client requests:\n\n`;
  for (const a of c.client.outstandingRequests) md += `- ${esc(a.summary)}${a.date ? ` (${a.date})` : ""} ${tag(a.provenance, a.sourceRef)}\n`;

  md += `\n## Team and stakeholders\n\n`;
  for (const p of c.team.members) md += `- ${esc(p.name)} - ${esc(p.responsibility)} ${tag(p.provenance, p.sourceRef)}\n`;
  md += `\n` + para("Departments", c.team.departments) + para("Escalation path", c.team.escalationPath);
  for (const p of c.team.externalStakeholders) md += `- External: ${esc(p.name)} - ${esc(p.businessRole)} ${tag(p.provenance, p.sourceRef)}\n`;

  md += `\n## Technical and operational knowledge\n\n`;
  md += para("Development process", c.technical.developmentProcess);
  md += `### Deployment procedure\n\n${esc(c.technical.deploymentProcedure)}\n\n`;
  md += para("Environment configuration references", c.technical.environmentReferences) + para("Monitoring", c.technical.monitoring);
  md += `### Troubleshooting\n\n${esc(c.technical.troubleshooting)}\n\n`;
  for (const k of c.technical.knownIncidents) md += `- Known incident: ${esc(k.summary)}${k.date ? ` (${k.date})` : ""} ${tag(k.provenance, k.sourceRef)}\n`;
  md += `\n` + para("Maintenance", c.technical.maintenance) + para("Repositories", c.technical.repositoryLinks.join(", "));

  md += `## Risks, decisions and undocumented knowledge\n\n`;
  for (const r of c.risks.risks) md += `- Risk (${r.impact} impact): ${esc(r.description)}${r.mitigation ? `; mitigation: ${esc(r.mitigation)}` : ""} ${tag(r.provenance, r.sourceRef)}\n`;
  md += `\n`;
  for (const d of c.risks.decisions) md += `- Decision${d.date ? ` (${d.date})` : ""}: ${esc(d.decision)}${d.rationale ? `; rationale: ${esc(d.rationale)}` : ""} ${tag(d.provenance, d.sourceRef)}\n`;
  md += `\n`;
  for (const ms of c.risks.upcomingMilestones) md += `- Milestone: ${esc(ms.name)} - ${ms.date || "date not set"} ${tag(ms.provenance, ms.sourceRef)}\n`;
  md += `\n` + para("Common mistakes", c.risks.commonMistakes) + para("Workarounds", c.risks.workarounds) + para("Technical debt", c.risks.technicalDebt);
  md += para("Recommendations for the incoming employee", c.risks.recommendations) + para("Undocumented knowledge", c.risks.tacitKnowledge);

  if (c.openQuestions.length) {
    md += `## Open questions\n\n`;
    for (const q of c.openQuestions) md += `- ${esc(q.question)} ${PROVENANCE_TAG.open_question}\n`;
  }
  return md;
}
