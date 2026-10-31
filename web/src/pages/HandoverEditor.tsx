import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApiError, get, post, put } from "../api";
import { HandoverView } from "../components/HandoverView";
import { Chip, ErrorAlert, LoadError, formatDate, formatDateTime, Progress, ProvenanceChip, PROVENANCE, PublicationChip, Spinner, StatusChip, useLoad, usePageTitle, useToast } from "../components/ui";
import { useAuth } from "../auth";
import { SAMPLE_ANSWERS } from "../demo";
import { newItem, SECTIONS, type FieldDef, type ListDef } from "../handover/sections";
import type { Completeness, Handover, HandoverContent, Provenance, SectionKey } from "../types";

type SaveState = { kind: "idle" } | { kind: "dirty" } | { kind: "saving" } | { kind: "saved"; at: string } | { kind: "error"; error: unknown };

const normPath = (p: string) => p.replace(/\[(\d+)\]/g, ".$1");
const fieldId = (p: string) => `f-${normPath(p)}`;

export function HandoverEditor() {
  const { id } = useParams();
  const { data: h, error, loading, reload } = useLoad(() => get<Handover>(`/api/handovers/${id}`), [id]);
  usePageTitle(h ? `Handover: ${h.project.name}` : "Handover");
  if (loading && !h) return <Spinner label="Loading handover" />;
  if (error) return <LoadError error={error} what="handover" />;
  if (!h) return null;
  if (!h.allowedActions.includes("edit")) return <ReadOnly h={h} />;
  return <Editor key={h.id + h.status} initial={h} onReload={reload} />;
}

function ReadOnly({ h }: { h: Handover }) {
  const content = h.content ?? h.approvedContent;
  return (
    <>
      <Header h={h} />
      {h.status === "submitted" && <div className="alert alert-info">Submitted on {formatDateTime(h.submittedAt)}. {h.manager.displayName} is reviewing it; editing is locked until a decision is made.</div>}
      {h.status === "approved" && <div className="alert alert-ok">Approved on {formatDateTime(h.approvedAt)} by {h.reviewedBy?.displayName}. This version is now the reference for {h.incoming?.displayName ?? "the incoming employee"}.</div>}
      {content && <div className="reading"><HandoverView content={content} /></div>}
    </>
  );
}

function Header({ h, right }: { h: Handover; right?: React.ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <span className="eyebrow">Handover · {h.project.code}</span>
        <h1>{h.project.name}</h1>
        <div className="row small muted">
          <StatusChip status={h.status} />
          <span>Client: {h.project.clientName}</span>
          <span>Due {formatDate(h.transferDueDate)}</span>
          <span>Reviewer: {h.manager.displayName}</span>
          {h.incoming && <span>Successor: {h.incoming.displayName}</span>}
          {h.approvedVersion && <PublicationChip pub={h.publication} />}
        </div>
      </div>
      {right}
    </div>
  );
}

function Editor({ initial, onReload }: { initial: Handover; onReload: () => void }) {
  const navigate = useNavigate();
  const [content, setContent] = useState<HandoverContent>(initial.content!);
  const [completeness, setCompleteness] = useState<Completeness>(initial.completeness!);
  const [step, setStep] = useState<SectionKey | "review">("overview");
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const revision = useRef(initial.revision);
  const pending = useRef<HandoverContent | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const inFlight = useRef(false);

  const flush = useCallback(async () => {
    if (inFlight.current || !pending.current) return;
    const toSave = pending.current;
    pending.current = null;
    inFlight.current = true;
    let failed = false;
    setSave({ kind: "saving" });
    try {
      const res = await put<{ revision: number; completeness: Completeness; savedAt: string }>(`/api/handovers/${initial.id}/draft`, { revision: revision.current, content: toSave });
      revision.current = res.revision;
      setCompleteness(res.completeness);
      setFieldErrors({});
      setSave(pending.current ? { kind: "dirty" } : { kind: "saved", at: res.savedAt });
    } catch (e) {
      if (e instanceof ApiError && e.status === 422) {
        setFieldErrors(Object.fromEntries(e.fieldIssues.map((i) => [normPath(i.path), i.message])));
      }
      if (!pending.current) pending.current = toSave; // keep unsaved work; the next edit or Retry re-sends it
      failed = true;
      setSave({ kind: "error", error: e });
    } finally {
      inFlight.current = false;
      // Edits made while this save was in flight are sent right after it.
      if (pending.current && !failed) timer.current = window.setTimeout(() => void flush(), 400);
    }
  }, [initial.id]);

  const update = (next: HandoverContent) => {
    setContent(next);
    pending.current = next;
    setSave({ kind: "dirty" });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), 1200);
  };

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (pending.current || inFlight.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  const setSection = (key: SectionKey, value: unknown) => update({ ...content, [key]: value } as HandoverContent);
  const { status } = useAuth();
  const demo = Boolean(status?.auth.simulated);
  const insertSample = (path: string) => {
    const [sec, key] = path.split(".") as [SectionKey, string];
    update({ ...content, [sec]: { ...(content[sec] as object), [key]: SAMPLE_ANSWERS[path] } } as HandoverContent);
    setStep(sec);
    window.setTimeout(() => document.getElementById(fieldId(path))?.focus(), 50);
  };
  const section = SECTIONS.find((s) => s.key === step);
  const questions = [
    ...completeness.missing.filter((m) => step === "review" || m.section === step).map((m) => ({ path: m.path, text: m.question, reason: `${m.label} is required` })),
    ...completeness.quality.filter((q) => step === "review" || q.path.startsWith(step)).map((q) => ({ path: q.path, text: q.question, reason: q.message })),
  ];

  const goTo = (path: string) => {
    const sec = path.split(".")[0] as SectionKey;
    if (SECTIONS.some((s) => s.key === sec)) setStep(sec);
    window.setTimeout(() => document.getElementById(fieldId(path))?.focus(), 50);
  };

  return (
    <>
      <Header h={initial} right={<SaveIndicator state={save} onRetry={() => void flush()} />} />
      {initial.status === "changes_requested" && initial.reviewComment && (
        <div className="alert alert-warn" role="status">
          <strong>{initial.reviewedBy?.displayName ?? "Your manager"} requested changes</strong>
          <span>{initial.reviewComment}</span>
        </div>
      )}
      {save.kind === "error" && <ErrorAlert error={save.error} title="Your latest changes are not saved" />}

      <nav className="steps" aria-label="Handover sections">
        {SECTIONS.map((s) => {
          const c = completeness.bySection[s.key];
          return (
            <button key={s.key} className={`step${c && c.present === c.required ? " complete" : ""}`} aria-current={step === s.key ? "step" : undefined} onClick={() => setStep(s.key)}>
              {s.title}
              {c && <span className="count">{c.present}/{c.required}</span>}
            </button>
          );
        })}
        <button className={`step${completeness.complete ? " complete" : ""}`} aria-current={step === "review" ? "step" : undefined} onClick={() => setStep("review")}>
          Review & submit <span className="count">{completeness.percent}%</span>
        </button>
      </nav>

      <div className="split">
        <div className="card">
          {section ? (
            <SectionForm def={section} value={content[section.key] as unknown as Record<string, unknown>} onChange={(v) => setSection(section.key, v)} errors={fieldErrors} />
          ) : (
            <ReviewStep
              h={initial}
              content={content}
              completeness={completeness}
              unsaved={save.kind !== "saved" && save.kind !== "idle"}
              onOpenQuestions={(q) => update({ ...content, openQuestions: q })}
              onSubmitted={() => {
                onReload();
                navigate(`/handovers/${initial.id}`);
              }}
            />
          )}
        </div>
        <aside aria-label="Interview assistant">
          <div className="card">
            <div className="card-head">
              <h3>Completeness</h3>
              <span className="num"><strong>{completeness.percent}%</strong></span>
            </div>
            <Progress value={completeness.percent} label="Handover completeness" />
            <div className="row small">
              {(Object.keys(PROVENANCE) as Provenance[]).map((p) => (
                <span key={p} className="row" style={{ gap: 4 }}>
                  <ProvenanceChip p={p} /> <span className="num">{completeness.provenance[p]}</span>
                </span>
              ))}
            </div>
          </div>
          <div className="card">
            <h3>Follow-up questions</h3>
            {questions.length === 0 ? (
              <div className="stack" style={{ gap: 10 }}>
                <p className="muted small">{step === "review" ? "Nothing outstanding." : "This section has everything required."}</p>
                {step !== "review" && completeness.missing.length > 0 && (
                  <>
                    <span className="eyebrow">Still missing in other sections</span>
                    {completeness.missing.map((m) => (
                      <div className="question" key={m.path}>
                        <span>{m.question}</span>
                        <span className="small muted">{SECTIONS.find((x) => x.key === m.section)?.title}: {m.label}</span>
                        <div className="row" style={{ gap: 4 }}>
                          <button className="btn btn-sm btn-ghost" onClick={() => goTo(m.path)}>Go to this question</button>
                          {demo && SAMPLE_ANSWERS[m.path] && (
                            <button className="btn btn-sm sample-answer" onClick={() => insertSample(m.path)} title="Demo only: fills in a synthetic answer">
                              Insert example answer
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </>
                )}
                {step !== "review" && completeness.complete && (
                  <button className="btn btn-primary btn-sm" style={{ justifySelf: "start" }} onClick={() => setStep("review")}>Go to Review & submit</button>
                )}
              </div>
            ) : (
              <div className="stack">
                {questions.slice(0, 8).map((q) => (
                  <div className="question" key={q.path + q.text}>
                    <span>{q.text}</span>
                    <span className="small muted">{q.reason}</span>
                    <div className="row" style={{ gap: 4 }}>
                      {q.path && (
                        <button className="btn btn-sm btn-ghost" onClick={() => goTo(q.path)}>
                          Answer this
                        </button>
                      )}
                      {demo && SAMPLE_ANSWERS[q.path] && (
                        <button className="btn btn-sm sample-answer" onClick={() => insertSample(q.path)} title="Demo only: fills in a synthetic answer">
                          Insert example answer
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <p className="small muted">Questions come from the required-field rules and quality checks. They never fill in answers for you.</p>
          </div>
        </aside>
      </div>
    </>
  );
}

function SaveIndicator({ state, onRetry }: { state: SaveState; onRetry: () => void }) {
  const text =
    state.kind === "saving" ? "Saving…" : state.kind === "dirty" ? "Unsaved changes" : state.kind === "saved" ? `Draft saved ${formatDateTime(state.at)}` : state.kind === "error" ? "Not saved" : "All changes saved";
  return (
    <div className="save-state" aria-live="polite">
      {state.kind === "saving" && <span className="spinner" aria-hidden="true" />}
      <span>{text}</span>
      {state.kind === "error" && !(state.error instanceof ApiError && state.error.status === 409) && (
        <button className="btn btn-sm" onClick={onRetry}>Retry</button>
      )}
      {state.kind === "error" && state.error instanceof ApiError && state.error.status === 409 && (
        <button className="btn btn-sm" onClick={() => window.location.reload()}>Reload latest</button>
      )}
    </div>
  );
}

// --- section form --------------------------------------------------------------

function SectionForm({ def, value, onChange, errors }: { def: (typeof SECTIONS)[number]; value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void; errors: Record<string, string> }) {
  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="stack" style={{ gap: 4 }}>
        <h2>{def.title}</h2>
        <p className="muted">{def.intro}</p>
      </div>
      {def.fields.length > 0 && (
        <div className="form-grid">
          {def.fields.map((f) => (
            <Field key={f.key} def={f} path={`${def.key}.${f.key}`} value={value[f.key]} error={errors[`${def.key}.${f.key}`]} onChange={(v) => onChange({ ...value, [f.key]: v })} />
          ))}
        </div>
      )}
      {def.lists.map((list) => (
        <ListEditor key={list.key} def={list} path={`${def.key}.${list.key}`} items={(value[list.key] as Record<string, unknown>[]) ?? []} errors={errors} onChange={(items) => onChange({ ...value, [list.key]: items })} />
      ))}
    </div>
  );
}

function Field({ def, path, value, onChange, error }: { def: FieldDef; path: string; value: unknown; onChange: (v: unknown) => void; error?: string }) {
  const id = fieldId(path);
  const common = { id, "aria-invalid": error ? true : undefined, "aria-describedby": error || def.hint ? `${id}-desc` : undefined };
  const [tagText, setTagText] = useState(Array.isArray(value) ? value.join(", ") : "");
  return (
    <div className="field" style={def.wide || def.kind === "textarea" ? { gridColumn: "1 / -1" } : undefined}>
      <label htmlFor={id}>
        {def.label}
        {def.required && <span className="req" aria-label="required">*</span>}
      </label>
      {def.kind === "textarea" && <textarea {...common} rows={def.wide ? 4 : 3} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} />}
      {def.kind === "text" && <input {...common} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} />}
      {def.kind === "date" && <input {...common} type="date" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} />}
      {def.kind === "select" && (
        <select {...common} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>
          {def.options!.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      )}
      {def.kind === "tags" && (
        <input
          {...common}
          value={tagText}
          onChange={(e) => {
            setTagText(e.target.value);
            onChange(e.target.value.split(",").map((s) => s.trim()).filter(Boolean));
          }}
        />
      )}
      {(error || def.hint) && (
        <span id={`${id}-desc`} className={error ? "err" : "hint"}>{error ?? def.hint}</span>
      )}
    </div>
  );
}

function ListEditor({ def, path, items, onChange, errors }: { def: ListDef; path: string; items: Record<string, unknown>[]; onChange: (v: Record<string, unknown>[]) => void; errors: Record<string, string> }) {
  const set = (i: number, patch: Record<string, unknown>) => onChange(items.map((it, j) => (j === i ? { ...it, ...patch } : it)));
  return (
    <div className="stack">
      <div className="card-head">
        <div className="stack" style={{ gap: 2 }}>
          <h3>
            {def.label}
            {def.required && <span className="req" style={{ color: "var(--danger)" }} aria-label="at least one required"> *</span>}
          </h3>
          {def.hint && <span className="small muted">{def.hint}</span>}
        </div>
        <button id={fieldId(path)} className="btn btn-sm" onClick={() => onChange([...items, newItem(def)])}>
          Add {def.itemNoun}
        </button>
      </div>
      {items.length === 0 && <p className="small muted">No {def.itemNoun}s yet.</p>}
      {items.map((it, i) => {
        const base = `${path}.${i}`;
        const prov = it.provenance as Provenance;
        return (
          <div className="item-card" key={String(it.id)}>
            <div className="item-card-head">
              <strong className="small">{String(it[def.titleField] || `New ${def.itemNoun}`)}</strong>
              <button className="btn btn-sm btn-ghost" onClick={() => onChange(items.filter((_, j) => j !== i))} aria-label={`Remove ${def.itemNoun} ${i + 1}`}>
                Remove
              </button>
            </div>
            <div className="form-grid">
              {def.fields.map((f) => (
                <Field key={f.key} def={f} path={`${base}.${f.key}`} value={it[f.key]} error={errors[`${base}.${f.key}`]} onChange={(v) => set(i, { [f.key]: v })} />
              ))}
              <div className="field">
                <label htmlFor={fieldId(`${base}.provenance`)}>How do you know this?</label>
                <select id={fieldId(`${base}.provenance`)} value={prov} onChange={(e) => set(i, { provenance: e.target.value })}>
                  {(Object.keys(PROVENANCE) as Provenance[]).map((p) => (
                    <option key={p} value={p}>{PROVENANCE[p].label}: {PROVENANCE[p].help}</option>
                  ))}
                </select>
              </div>
              <Field
                def={{ key: "sourceRef", label: prov === "confirmed" ? "Source (required for confirmed)" : "Source (optional)", kind: "text", hint: "Document name, ticket or URL" }}
                path={`${base}.sourceRef`}
                value={it.sourceRef}
                error={errors[`${base}.sourceRef`] ?? (prov === "confirmed" && !String(it.sourceRef ?? "").trim() ? "Add the source that confirms this" : undefined)}
                onChange={(v) => set(i, { sourceRef: v })}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// --- review & submit ----------------------------------------------------------------

function ReviewStep({ h, content, completeness, unsaved, onOpenQuestions, onSubmitted }: { h: Handover; content: HandoverContent; completeness: Completeness; unsaved: boolean; onOpenQuestions: (q: HandoverContent["openQuestions"]) => void; onSubmitted: () => void }) {
  const [attest, setAttest] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [newQ, setNewQ] = useState("");
  const toast = useToast();
  const blockers = useMemo(() => completeness.missing.map((m) => m.label), [completeness]);

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="stack" style={{ gap: 4 }}>
        <h2>Review & submit</h2>
        <p className="muted">Read the draft as your successor will. Correct anything inaccurate before submitting it to {h.manager.displayName}.</p>
      </div>
      {blockers.length > 0 ? (
        <div className="alert alert-warn">
          <strong>{blockers.length} required item{blockers.length > 1 ? "s" : ""} missing</strong>
          <span>{blockers.join(", ")}</span>
        </div>
      ) : (
        <div className="alert alert-ok">All required sections are complete.</div>
      )}

      <div className="stack">
        <h3>Open questions</h3>
        <p className="small muted">Things you could not answer. They are passed on as unresolved, never as facts.</p>
        {content.openQuestions.map((q) => (
          <div key={q.id} className="row" style={{ justifyContent: "space-between" }}>
            <span>{q.question}</span>
            <button className="btn btn-sm btn-ghost" onClick={() => onOpenQuestions(content.openQuestions.filter((x) => x.id !== q.id))}>Remove</button>
          </div>
        ))}
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (!newQ.trim()) return;
            onOpenQuestions([...content.openQuestions, { id: crypto.randomUUID(), question: newQ.trim() }]);
            setNewQ("");
          }}
        >
          <label htmlFor="new-open-question" className="visually-hidden">New open question</label>
          <input id="new-open-question" style={{ flex: 1 }} value={newQ} onChange={(e) => setNewQ(e.target.value)} placeholder="e.g. Who approves the Q1 budget?" />
          <button className="btn btn-sm" type="submit">Add question</button>
        </form>
      </div>

      <details>
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>Preview the full draft</summary>
        <div style={{ marginTop: 14 }}>
          <HandoverView content={content} />
        </div>
      </details>

      <label className="checkbox" htmlFor="attest">
        <input id="attest" type="checkbox" checked={attest} onChange={(e) => setAttest(e.target.checked)} />
        <span>I reviewed this handover. It is accurate to the best of my knowledge, statements are labelled with how I know them, and it contains no passwords, keys or personal data that is not needed.</span>
      </label>
      <ErrorAlert error={error} />
      <div className="row">
        <button
          className="btn btn-primary"
          disabled={!attest || !completeness.complete || unsaved || busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await post(`/api/handovers/${h.id}/submit`, { attestation: true });
              toast(`Submitted to ${h.manager.displayName} for review`);
              onSubmitted();
            } catch (e) {
              setError(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Submitting…" : `Submit to ${h.manager.displayName} for review`}
        </button>
        {unsaved && <span className="small muted">Waiting for the draft to save…</span>}
        <Link to="/" className="btn btn-ghost">Back to home</Link>
      </div>
      <Chip tone="neutral">Due {formatDate(h.transferDueDate)}</Chip>
    </div>
  );
}
