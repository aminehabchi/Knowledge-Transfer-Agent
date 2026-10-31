import { SECTIONS } from "../handover/sections";
import type { HandoverContent, Provenance } from "../types";
import { ProvenanceChip } from "./ui";

type Item = { id: string; provenance: Provenance; sourceRef: string } & Record<string, unknown>;

function display(v: unknown): string {
  if (Array.isArray(v)) return v.join(", ");
  return String(v ?? "");
}

/** Read-only handover, laid out as a long-form article; each list item shows how it is known. */
export function HandoverView({ content }: { content: HandoverContent }) {
  return (
    <div className="hv">
      <p className="small muted">Written text in each section is the outgoing employee's own account. List items are labelled confirmed, reported, assumption or open question.</p>
      {SECTIONS.map((section) => {
        const data = content[section.key] as unknown as Record<string, unknown>;
        const fields = section.fields.filter((f) => display(data[f.key]).trim() !== "");
        const lists = section.lists.filter((l) => ((data[l.key] as Item[]) ?? []).length > 0);
        if (fields.length === 0 && lists.length === 0) return null;
        return (
          <section key={section.key} aria-labelledby={`hv-${section.key}`}>
            <h3 id={`hv-${section.key}`}>{section.title}</h3>
            {fields.map((f) => (
              <div className="field-block" key={f.key}>
                <span className="field-label">{f.label}</span>
                <p className="field-text">{display(data[f.key])}</p>
              </div>
            ))}
            {lists.map((list) => (
              <div key={list.key} className="field-block" style={{ gap: 10 }}>
                <span className="field-label">{list.label}</span>
                <ul>
                  {((data[list.key] as Item[]) ?? []).map((it) => (
                    <li key={it.id}>
                      <div>
                        <strong>{display(it[list.titleField])}</strong>
                        <span className="small muted">
                          {list.fields
                            .filter((f) => f.key !== list.titleField && display(it[f.key]).trim() !== "")
                            .map((f) => `${f.label}: ${display(it[f.key])}`)
                            .join(" · ")}
                        </span>
                        {it.sourceRef && <span className="small muted">Source: {it.sourceRef}</span>}
                      </div>
                      <ProvenanceChip p={it.provenance} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        );
      })}
      {content.openQuestions.length > 0 && (
        <section aria-labelledby="hv-open">
          <h3 id="hv-open">Open questions</h3>
          <ul>
            {content.openQuestions.map((q) => (
              <li key={q.id}>
                <div><strong>{q.question}</strong></div>
                <ProvenanceChip p="open_question" />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
