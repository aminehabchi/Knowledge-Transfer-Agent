import { z } from "zod";
import type { DocType } from "../retrieval/index-service.ts";
import type { Provenance } from "../handover/schema.ts";

/** A retrieved passage as shown to a model. `label` (S1, S2…) is the only id the model sees. */
export interface SourcePassage {
  label: string;
  title: string;
  heading: string;
  docType: DocType;
  provenance: Provenance | null;
  stale: boolean;
  text: string;
}

export interface AnswerRequest {
  question: string;
  projectName: string;
  passages: SourcePassage[];
}

export const StatementKind = z.enum(["verified", "reported", "recommendation", "unanswered"]);

/** What a provider returns. The assistant service validates and post-processes it. */
export const DraftAnswer = z.object({
  status: z.enum(["answered", "insufficient_evidence"]),
  statements: z
    .array(
      z.object({
        text: z.string().min(1).max(2000),
        kind: StatementKind,
        citations: z.array(z.string().max(8)).max(10),
      }),
    )
    .max(20),
  contradictions: z
    .array(z.object({ description: z.string().min(1).max(1000), citations: z.array(z.string().max(8)).max(10) }))
    .max(10),
});
export type DraftAnswer = z.infer<typeof DraftAnswer>;

export interface LlmProvider {
  /** Stable identifier stored with each answer. */
  readonly id: string;
  /** Human-readable label shown in the UI. */
  readonly label: string;
  /** False for the local extractive provider: it can only quote sources, never generate. */
  readonly generative: boolean;
  answer(req: AnswerRequest): Promise<DraftAnswer>;
}

export class ProviderUnavailableError extends Error {}
