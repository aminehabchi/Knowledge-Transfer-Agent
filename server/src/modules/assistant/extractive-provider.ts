import { PROVENANCE_TAG } from "../handover/render.ts";
import { queryTerms } from "../retrieval/text.ts";
import type { AnswerRequest, DraftAnswer, LlmProvider } from "./provider.ts";

const stem = (t: string) => t.slice(0, 5);
const TAGS = Object.values(PROVENANCE_TAG);

function clean(s: string) {
  let out = s;
  for (const t of TAGS) out = out.split(t).join("");
  return out.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "").replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
}

/**
 * LOCAL EXTRACTIVE provider - not an LLM. It answers only by quoting the source sentences that best
 * match the question, so it cannot hallucinate, but it cannot synthesise, recommend, or detect
 * contradictions either. Used in demo mode when no LLM provider is configured.
 */
export class ExtractiveProvider implements LlmProvider {
  readonly id = "extractive";
  readonly label = "Local extractive search (no generative AI)";
  readonly generative = false;

  async answer(req: AnswerRequest): Promise<DraftAnswer> {
    const q = queryTerms(req.question).map(stem);
    const needed = q.length <= 2 ? 1 : 2;
    const overlap = (s: string) => {
      const words = new Set(queryTerms(s).map(stem));
      return q.filter((t) => words.has(t)).length;
    };
    const candidates: { text: string; label: string; score: number; rank: number; pos: number; kind: "verified" | "reported" }[] = [];

    req.passages.forEach((p, rank) => {
      // A section whose heading matches the question ("Deployment steps") makes each of its lines relevant.
      const headingScore = overlap(p.heading);
      const units = p.text.split(/\n+|(?<=[.!?])\s+(?=[A-Z])/).map(clean).filter((u) => u.length > 12);
      units.forEach((u, pos) => {
        const own = overlap(u);
        const score = own + headingScore;
        if (score >= needed && (own > 0 || headingScore >= needed)) {
          const authoritative = p.docType !== "handover" || p.provenance === "confirmed";
          candidates.push({ text: u, label: p.label, score, rank, pos, kind: authoritative ? "verified" : "reported" });
        }
      });
    });
    const unique = candidates.filter((c, i, all) => all.findIndex((o) => o.text === c.text) === i);
    // Keep the best-scoring lines, then present them in source order so procedures read as steps.
    const picked = [...unique]
      .sort((a, b) => b.score - a.score || a.rank - b.rank || a.pos - b.pos)
      .slice(0, 6)
      .sort((a, b) => a.rank - b.rank || a.pos - b.pos);
    if (picked.length === 0) return { status: "insufficient_evidence", statements: [], contradictions: [] };
    return {
      status: "answered",
      statements: picked.map((c) => ({ text: c.text, kind: c.kind, citations: [c.label] })),
      contradictions: [],
    };
  }
}
