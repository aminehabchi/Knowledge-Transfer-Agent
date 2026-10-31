import type { Provenance } from "../handover/schema.ts";
import { PROVENANCE_TAG } from "../handover/render.ts";

const SUPPORTED = new Set(["md", "markdown", "txt", "csv", "json", "html", "htm"]);

export function isSupported(name: string) {
  return SUPPORTED.has(extension(name));
}

const extension = (name: string) => name.toLowerCase().split(".").pop() ?? "";

/** Extracts plain text. Binary Office/PDF formats are reported as unsupported rather than guessed. */
export function extractText(name: string, bytes: Uint8Array): string {
  const raw = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const ext = extension(name);
  if (ext === "html" || ext === "htm") {
    return raw
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/[ \t]+/g, " ");
  }
  return raw;
}

// --- chunking -----------------------------------------------------------------

export interface Chunk {
  heading: string;
  text: string;
  provenance: Provenance | null;
}

const MAX_CHUNK = 900;

const TAG_TO_PROVENANCE = Object.entries(PROVENANCE_TAG).map(([p, tag]) => ({ p: p as Provenance, tag }));

function provenanceOf(block: string, fallback: Provenance | null): Provenance | null {
  return TAG_TO_PROVENANCE.find(({ tag }) => block.includes(tag))?.p ?? fallback;
}

/**
 * Splits Markdown/plain text into heading-scoped chunks. Each paragraph or list item is a block;
 * consecutive blocks are packed up to ~900 chars, but never across a heading or across different
 * provenance labels, so every chunk has a single, accurate provenance.
 */
export function chunkText(text: string, opts: { defaultProvenance: Provenance | null }): Chunk[] {
  const chunks: Chunk[] = [];
  let heading = "";
  let buf: string[] = [];
  let bufProv: Provenance | null = null;

  const flush = () => {
    const body = buf.join("\n").trim();
    if (body) chunks.push({ heading, text: body, provenance: bufProv });
    buf = [];
  };

  const blocks: string[] = [];
  let para: string[] = [];
  for (const line of text.replace(/\r/g, "").split("\n")) {
    const isHeading = /^#{1,6}\s/.test(line);
    const isItem = /^\s*(?:[-*+]|\d+\.)\s/.test(line);
    if (isHeading || isItem || line.trim() === "") {
      if (para.length) blocks.push(para.join(" "));
      para = [];
      if (isHeading || isItem) blocks.push(line);
      continue;
    }
    para.push(line.trim());
  }
  if (para.length) blocks.push(para.join(" "));

  for (const block of blocks) {
    const h = /^(#{1,6})\s+(.*)$/.exec(block);
    if (h) {
      flush();
      heading = h[2]!.trim();
      continue;
    }
    const prov = provenanceOf(block, opts.defaultProvenance);
    for (const piece of splitLong(block.trim())) {
      const size = buf.reduce((n, b) => n + b.length + 1, 0);
      if (buf.length && (prov !== bufProv || size + piece.length > MAX_CHUNK)) flush();
      bufProv = prov;
      buf.push(piece);
    }
  }
  flush();
  return chunks;
}

function splitLong(block: string): string[] {
  if (block.length <= MAX_CHUNK) return [block];
  const sentences = block.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [block];
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if ((cur + s).length > MAX_CHUNK && cur) {
      out.push(cur.trim());
      cur = "";
    }
    cur += s;
    while (cur.length > MAX_CHUNK) {
      out.push(cur.slice(0, MAX_CHUNK));
      cur = cur.slice(MAX_CHUNK);
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// --- prompt-injection screening -------------------------------------------------

const INJECTION_PATTERNS: RegExp[] = [
  /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|system|your)\b[^.\n]{0,20}\b(instructions?|prompts?|rules|polic(y|ies))/i,
  /\byou are now\b/i,
  /\b(reveal|print|show|output|leak)\b[^.\n]{0,30}\b(system prompt|instructions|secrets?|api keys?|credentials|passwords?)\b/i,
  /<\/?\s*(system|assistant|instructions?)\s*>/i,
  /\b(do not|don't|never)\s+(tell|inform|show)\s+the\s+user\b/i,
  /\b(grant|give)\s+(me|this user|the user|everyone)\b[^.\n]{0,30}\baccess\b/i,
  /\b(new|updated) (system )?instructions?\s*:/i,
];

/** Returns a reason when text contains instruction-like content aimed at an AI model. */
export function screenForInjection(text: string): string | null {
  const hit = INJECTION_PATTERNS.find((re) => re.test(text));
  return hit ? "Contains instruction-like text addressed to an AI system" : null;
}

// --- query parsing ------------------------------------------------------------

const STOPWORDS = new Set(
  "a an and are as at be by can do does for from has have how i in is it its me my of on or our should the their this to was we what when where which who whom why will with you your about into than then there these those any all".split(" "),
);

export function queryTerms(q: string): string[] {
  const terms = (q.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []).filter((t) => !STOPWORDS.has(t));
  return [...new Set(terms)].slice(0, 24);
}

/** Builds a safe FTS5 MATCH expression: every term quoted, OR-combined. */
export function ftsQuery(terms: string[]): string {
  return terms.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
}
