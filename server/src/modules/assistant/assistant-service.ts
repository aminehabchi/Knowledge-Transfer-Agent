import { z } from "zod";
import type { Db } from "../../db/database.ts";
import { AppError } from "../../lib/errors.ts";
import type { RateLimiter } from "../../lib/rate-limit.ts";
import { iso, newId, type Clock } from "../../lib/util.ts";
import type { AuditLog } from "../audit/audit.ts";
import type { Principal } from "../identity/users.ts";
import type { ProjectService } from "../projects/projects.ts";
import type { IndexService, Passage } from "../retrieval/index-service.ts";
import { MOCK_URL_SCHEME } from "../sharepoint/mock-adapter.ts";
import { ProviderUnavailableError, type LlmProvider, type SourcePassage } from "./provider.ts";

export const AskInput = z.object({ question: z.string().trim().min(3).max(1000) });

export type StatementKind = "verified" | "reported" | "recommendation" | "unanswered";

export interface Citation {
  label: string;
  documentId: string;
  documentName: string;
  docType: string;
  heading: string;
  excerpt: string;
  /** Real SharePoint URL (graph mode) or null when the source lives in the mock store. */
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
  statements: { text: string; kind: StatementKind; citations: string[] }[];
  citations: Citation[];
  warnings: { kind: "stale_source" | "contradiction" | "withheld_source" | "removed_unsupported" | "unverified_source"; message: string; citations: string[] }[];
  suggestedContacts: { name: string; role: string }[];
  provider: { id: string; label: string; generative: boolean };
  createdAt: string;
}

/**
 * Retrieval-augmented onboarding assistant. Authorization and grounding are enforced here, not
 * trusted to the model: only passages the user may read are retrieved; instruction-like passages
 * are withheld; every cited id must be one of the passages sent; unsupported factual statements
 * are removed; statement kinds are re-derived from the cited sources.
 */
export class AssistantService {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly projects: ProjectService;
  private readonly index: IndexService;
  private readonly provider: LlmProvider;
  private readonly limiter: RateLimiter;
  private readonly audit: AuditLog;

  constructor(deps: { db: Db; clock: Clock; projects: ProjectService; index: IndexService; provider: LlmProvider; limiter: RateLimiter; audit: AuditLog }) {
    this.db = deps.db;
    this.clock = deps.clock;
    this.projects = deps.projects;
    this.index = deps.index;
    this.provider = deps.provider;
    this.limiter = deps.limiter;
    this.audit = deps.audit;
  }

  async ask(user: Principal, projectId: string, input: unknown): Promise<AssistantAnswer> {
    this.projects.requireMember(user, projectId);
    const { question } = AskInput.parse(input);
    this.limiter.consume(`assistant:${user.id}`);
    const project = this.projects.get(projectId);

    const retrieved = this.index.search(user, projectId, question, 8);
    const usable = retrieved.filter((p) => !p.flagged).slice(0, 6);
    const withheld = retrieved.filter((p) => p.flagged);
    const byLabel = new Map<string, Passage>(usable.map((p, i) => [`S${i + 1}`, p]));

    const warnings: AssistantAnswer["warnings"] = [];
    if (withheld.length) {
      const names = [...new Set(withheld.map((p) => p.documentName))].join(", ");
      warnings.push({
        kind: "withheld_source",
        message: `${withheld.length} matching passage(s) from ${names} were withheld because they contain instruction-like text. Ask the document owner to review them.`,
        citations: [],
      });
    }

    let draft;
    if (usable.length === 0) {
      draft = { status: "insufficient_evidence" as const, statements: [], contradictions: [] };
    } else {
      const passages: SourcePassage[] = [...byLabel].map(([label, p]) => ({
        label,
        title: p.documentName,
        heading: p.heading,
        docType: p.docType,
        provenance: p.provenance,
        stale: p.stale,
        text: p.text,
      }));
      try {
        draft = await this.provider.answer({ question, projectName: project.name, passages });
      } catch (err) {
        this.audit.record({ actorId: user.id, action: "assistant.ask", entityType: "project", entityId: projectId, projectId, outcome: "failure", details: { provider: this.provider.id } });
        if (err instanceof ProviderUnavailableError) throw new AppError(503, "assistant_unavailable", err.message);
        throw new AppError(503, "assistant_unavailable", "The assistant is temporarily unavailable.");
      }
    }

    // --- grounding enforcement --------------------------------------------------
    const statements: AssistantAnswer["statements"] = [];
    let removed = 0;
    for (const s of draft.statements) {
      const cites = [...new Set(s.citations)].filter((c) => byLabel.has(c));
      if (s.kind === "unanswered") {
        statements.push({ text: s.text, kind: "unanswered", citations: [] });
        continue;
      }
      if (s.kind === "recommendation") {
        statements.push({ text: s.text, kind: "recommendation", citations: cites });
        continue;
      }
      if (cites.length === 0) {
        removed++;
        continue;
      }
      const sources = cites.map((c) => byLabel.get(c)!);
      const authoritative = sources.some((p) => p.docType !== "handover" || p.provenance === "confirmed");
      statements.push({ text: s.text, kind: authoritative ? "verified" : "reported", citations: cites });
      const weak = sources.filter((p) => p.provenance === "assumption" || p.provenance === "open_question");
      if (!authoritative && weak.length) {
        warnings.push({ kind: "unverified_source", message: "Part of this answer relies on items the outgoing employee marked as assumptions or open questions.", citations: cites });
      }
    }
    if (removed) {
      warnings.push({ kind: "removed_unsupported", message: `${removed} statement(s) without valid source references were removed.`, citations: [] });
    }
    for (const c of draft.contradictions) {
      const cites = c.citations.filter((x) => byLabel.has(x));
      if (cites.length >= 2) warnings.push({ kind: "contradiction", message: c.description, citations: cites });
    }
    const cited = new Set(statements.flatMap((s) => s.citations).concat(warnings.flatMap((w) => w.citations)));
    const staleCited = [...cited].filter((c) => byLabel.get(c)?.stale);
    if (staleCited.length) {
      warnings.push({ kind: "stale_source", message: "Some cited documents have not been updated recently and may be out of date.", citations: staleCited });
    }

    const hasFacts = statements.some((s) => s.kind === "verified" || s.kind === "reported");
    const status = draft.status === "answered" && hasFacts ? "answered" : "insufficient_evidence";
    if (status === "insufficient_evidence" && !statements.some((s) => s.kind === "unanswered")) {
      statements.unshift({ text: "I could not find enough evidence in the approved handover or the project documents you can access to answer this.", kind: "unanswered", citations: [] });
    }
    // Contacts come from project membership in the database - never from model output.
    const suggestedContacts = status === "insufficient_evidence" ? this.projects.managers(projectId).map((m) => ({ name: m.displayName, role: "Project manager" })) : [];

    const answer: AssistantAnswer = {
      id: newId(),
      question,
      status,
      statements,
      citations: [...byLabel].filter(([label]) => cited.has(label)).map(([label, p]) => toCitation(label, p)),
      warnings,
      suggestedContacts,
      provider: { id: this.provider.id, label: this.provider.label, generative: this.provider.generative },
      createdAt: iso(this.clock.now()),
    };
    this.db
      .prepare("INSERT INTO assistant_messages (id, project_id, user_id, question, answer_json, provider, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(answer.id, projectId, user.id, question, JSON.stringify(answer), this.provider.id, answer.createdAt);
    this.audit.record({
      actorId: user.id,
      action: "assistant.ask",
      entityType: "assistant_message",
      entityId: answer.id,
      projectId,
      details: { status, citedDocuments: answer.citations.map((c) => c.documentId), withheld: withheld.length, removed },
    });
    return answer;
  }

  history(user: Principal, projectId: string, limit = 30): AssistantAnswer[] {
    this.projects.requireMember(user, projectId);
    return this.db
      .prepare("SELECT answer_json FROM assistant_messages WHERE project_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(projectId, user.id, limit)
      .map((r) => JSON.parse(String(r.answer_json)) as AssistantAnswer)
      .reverse();
  }
}

function toCitation(label: string, p: Passage): Citation {
  const simulated = p.webUrl.startsWith(MOCK_URL_SCHEME);
  return {
    label,
    documentId: p.documentId,
    documentName: p.documentName,
    docType: p.docType,
    heading: p.heading,
    excerpt: p.text.length > 400 ? `${p.text.slice(0, 400)}…` : p.text,
    webUrl: simulated ? null : p.webUrl,
    simulatedSource: simulated,
    versionLabel: p.versionLabel,
    lastModifiedAt: p.lastModifiedAt,
    stale: p.stale,
  };
}
