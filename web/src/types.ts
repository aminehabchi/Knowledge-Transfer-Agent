// Response shapes of the server API (kept in sync with server/src/modules/**).

export interface User {
  id: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
  isManager: boolean;
}

export interface Person {
  id: string;
  displayName: string;
  email: string;
}

export type ProjectRole = "manager" | "outgoing" | "incoming";

export interface Project {
  id: string;
  code: string;
  name: string;
  clientName: string;
  description: string;
  status: string;
  myRoles: ProjectRole[];
  members?: { userId: string; displayName: string; email: string; role: ProjectRole }[];
}

export type Provenance = "confirmed" | "reported" | "assumption" | "open_question";
export type HandoverStatus = "draft" | "submitted" | "changes_requested" | "approved" | "cancelled";

interface Base {
  id: string;
  provenance: Provenance;
  sourceRef: string;
}
export interface TaskItem extends Base { title: string; status: "done" | "in_progress" | "pending" | "blocked"; owner: string; dueDate: string; priority: "low" | "medium" | "high" | "critical"; blockers: string; links: string[] }
export interface ContactItem extends Base { name: string; businessRole: string; channel: string; notes: string }
export interface StatementItem extends Base { summary: string; date: string }
export interface TeamMember extends Base { name: string; responsibility: string }
export interface RiskItem extends Base { description: string; impact: "low" | "medium" | "high"; mitigation: string }
export interface DecisionItem extends Base { decision: string; rationale: string; date: string }
export interface MilestoneItem extends Base { name: string; date: string }

export interface HandoverContent {
  overview: { projectSummary: string; clientContext: string; objectives: string; scope: string; deliverables: string; successCriteria: string; lifecycleStage: string; currentStatus: string; architecture: string; technologies: string[]; integrations: string };
  tasks: { items: TaskItem[] };
  client: { requirements: string; expectations: string; communicationProtocol: string; contacts: ContactItem[]; agreements: StatementItem[]; outstandingRequests: StatementItem[] };
  team: { members: TeamMember[]; departments: string; escalationPath: string; externalStakeholders: ContactItem[] };
  technical: { developmentProcess: string; deploymentProcedure: string; environmentReferences: string; monitoring: string; troubleshooting: string; knownIncidents: StatementItem[]; maintenance: string; repositoryLinks: string[] };
  risks: { risks: RiskItem[]; decisions: DecisionItem[]; commonMistakes: string; workarounds: string; technicalDebt: string; upcomingMilestones: MilestoneItem[]; recommendations: string; tacitKnowledge: string };
  openQuestions: { id: string; question: string }[];
}

export type SectionKey = "overview" | "tasks" | "client" | "team" | "technical" | "risks";

export interface Completeness {
  percent: number;
  complete: boolean;
  missing: { section: SectionKey; path: string; label: string; question: string }[];
  bySection: Record<SectionKey, { required: number; present: number }>;
  quality: { path: string; message: string; question: string }[];
  provenance: Record<Provenance, number>;
}

export interface Publication {
  version: number;
  status: "pending" | "synced" | "failed";
  adapterMode: string;
  webUrl: string | null;
  remotePath: string | null;
  metadataStatus: string | null;
  attempts: number;
  lastError: string | null;
  syncedAt: string | null;
}

export interface Handover {
  id: string;
  project: { id: string; code: string; name: string; clientName: string };
  status: HandoverStatus;
  myRoles: string[];
  allowedActions: ("edit" | "submit" | "approve" | "request_changes" | "cancel")[];
  manager: Person;
  outgoing: Person;
  incoming: Person | null;
  transferDueDate: string;
  onboardingStartDate: string | null;
  revision: number;
  currentVersion: number;
  approvedVersion: number | null;
  submittedAt: string | null;
  authorAttestedAt: string | null;
  reviewedAt: string | null;
  reviewedBy: Person | null;
  reviewComment: string | null;
  approvedAt: string | null;
  updatedAt: string;
  content: HandoverContent | null;
  submittedContent: HandoverContent | null;
  approvedContent: HandoverContent | null;
  completeness: Completeness | null;
  versions: { version: number; submittedBy: Person; submittedAt: string; decision: string | null; decidedBy: Person | null; decidedAt: string | null }[];
  publication: Publication | null;
}

export interface HandoverSummary {
  id: string;
  project: { id: string; code: string; name: string; clientName: string };
  status: HandoverStatus;
  myRoles: string[];
  outgoing: Person;
  incoming: Person | null;
  manager: Person;
  transferDueDate: string;
  overdue: boolean;
  completenessPercent: number | null;
  missingSections: SectionKey[];
  publication: Publication | null;
  updatedAt: string;
}

export interface SystemStatus {
  environment: string;
  auth: { mode: string; simulated: boolean };
  sharepoint: { mode: string; simulated: boolean };
  assistant: { provider: string; label: string; generative: boolean };
}

export interface Citation {
  label: string;
  documentId: string;
  documentName: string;
  docType: string;
  heading: string;
  excerpt: string;
  webUrl: string | null;
  simulatedSource: boolean;
  versionLabel: string | null;
  lastModifiedAt: string | null;
  stale: boolean;
}

export interface AssistantAnswer {
  id: string;
  question: string;
  status: "answered" | "insufficient_evidence";
  statements: { text: string; kind: "verified" | "reported" | "recommendation" | "unanswered"; citations: string[] }[];
  citations: Citation[];
  warnings: { kind: string; message: string; citations: string[] }[];
  suggestedContacts: { name: string; role: string }[];
  provider: { id: string; label: string; generative: boolean };
  createdAt: string;
}

export interface DocumentSummary {
  id: string;
  name: string;
  docType: string;
  webUrl: string;
  versionLabel: string | null;
  lastModifiedAt: string | null;
  superseded: boolean;
  ingestStatus: "indexed" | "unsupported_format" | "error";
  ingestError: string | null;
  flaggedChunks: number;
  indexedAt: string;
}
