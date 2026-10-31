import { z } from "zod";

/**
 * How a statement in the handover is known:
 *  - confirmed:     backed by a referenced source (document URL / ticket / repo); sourceRef required
 *  - reported:      stated by the outgoing employee from their own knowledge
 *  - assumption:    believed but not verified
 *  - open_question: unresolved; must not be presented as fact
 */
export const Provenance = z.enum(["confirmed", "reported", "assumption", "open_question"]);
export type Provenance = z.infer<typeof Provenance>;

const text = (max = 4000) => z.string().trim().max(max).default("");
const shortText = () => text(300);
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .or(z.literal(""))
  .default("");
const link = z.string().trim().max(1000);

const item = <T extends z.ZodRawShape>(shape: T) =>
  z
    .object({
      id: z.string().min(1).max(64),
      provenance: Provenance.default("reported"),
      sourceRef: z.string().trim().max(1000).default(""),
      ...shape,
    })
    .refine((v) => (v as { provenance: string }).provenance !== "confirmed" || (v as { sourceRef: string }).sourceRef.length > 0, {
      message: "Confirmed items must reference a source",
      path: ["sourceRef"],
    });

export const TaskItem = item({
  title: z.string().trim().min(1).max(300),
  status: z.enum(["done", "in_progress", "pending", "blocked"]).default("pending"),
  owner: shortText(),
  dueDate: isoDate,
  priority: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  blockers: text(1000),
  links: z.array(link).max(20).default([]),
});

export const ContactItem = item({
  name: z.string().trim().min(1).max(200),
  businessRole: shortText(),
  /** Approved business channel only (e.g. shared mailbox, Teams channel) - never personal details. */
  channel: shortText(),
  notes: text(1000),
});

export const StatementItem = item({ summary: z.string().trim().min(1).max(2000), date: isoDate });

export const TeamMember = item({ name: z.string().trim().min(1).max(200), responsibility: shortText() });

export const RiskItem = item({
  description: z.string().trim().min(1).max(2000),
  impact: z.enum(["low", "medium", "high"]).default("medium"),
  mitigation: text(1000),
});

export const DecisionItem = item({
  decision: z.string().trim().min(1).max(1000),
  rationale: text(2000),
  date: isoDate,
});

export const MilestoneItem = item({ name: z.string().trim().min(1).max(300), date: isoDate });

export const LIFECYCLE_STAGES = ["initiation", "planning", "execution", "stabilisation", "maintenance", "closing"] as const;

export const HandoverContent = z.object({
  overview: z
    .object({
      projectSummary: text(),
      clientContext: text(),
      objectives: text(),
      scope: text(),
      deliverables: text(),
      successCriteria: text(),
      lifecycleStage: z.enum(LIFECYCLE_STAGES).or(z.literal("")).default(""),
      currentStatus: text(),
      architecture: text(6000),
      technologies: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
      integrations: text(),
    })
    .prefault({}),
  tasks: z.object({ items: z.array(TaskItem).max(200).default([]) }).prefault({}),
  client: z
    .object({
      requirements: text(),
      expectations: text(),
      communicationProtocol: text(),
      contacts: z.array(ContactItem).max(50).default([]),
      agreements: z.array(StatementItem).max(100).default([]),
      outstandingRequests: z.array(StatementItem).max(100).default([]),
    })
    .prefault({}),
  team: z
    .object({
      members: z.array(TeamMember).max(100).default([]),
      departments: text(),
      escalationPath: text(),
      externalStakeholders: z.array(ContactItem).max(50).default([]),
    })
    .prefault({}),
  technical: z
    .object({
      developmentProcess: text(),
      deploymentProcedure: text(6000),
      environmentReferences: text(),
      monitoring: text(),
      troubleshooting: text(6000),
      knownIncidents: z.array(StatementItem).max(100).default([]),
      maintenance: text(),
      repositoryLinks: z.array(link).max(50).default([]),
    })
    .prefault({}),
  risks: z
    .object({
      risks: z.array(RiskItem).max(100).default([]),
      decisions: z.array(DecisionItem).max(100).default([]),
      commonMistakes: text(),
      workarounds: text(),
      technicalDebt: text(),
      upcomingMilestones: z.array(MilestoneItem).max(50).default([]),
      recommendations: text(),
      tacitKnowledge: text(6000),
    })
    .prefault({}),
  openQuestions: z
    .array(z.object({ id: z.string().min(1).max(64), question: z.string().trim().min(1).max(1000) }))
    .max(100)
    .default([]),
});

export type HandoverContent = z.infer<typeof HandoverContent>;

export const emptyContent = (): HandoverContent => HandoverContent.parse({});

export const SECTION_KEYS = ["overview", "tasks", "client", "team", "technical", "risks"] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];
