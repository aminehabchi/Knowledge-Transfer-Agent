import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { get, post } from "../api";
import { Avatar, Chip, Empty, ErrorAlert, formatDate, formatDateTime, Progress, PublicationChip, Spinner, StatusChip, useLoad, usePageTitle, useToast } from "../components/ui";
import { SECTIONS } from "../handover/sections";
import type { Handover, HandoverStatus, HandoverSummary, Person, Project } from "../types";

interface Health {
  sharepoint: { mode: string; simulated: boolean; ok: boolean; detail: string; checkedAt: string };
  assistant: { label: string; generative: boolean };
  email: { mode: string; detail: string };
  publications: Record<string, number>;
  jobs: { type: string; status: string; n: number }[];
}

const SECTION_TITLE = Object.fromEntries(SECTIONS.map((s) => [s.key, s.title]));

export function ManagerDashboard() {
  const handovers = useLoad(() => get<HandoverSummary[]>("/api/handovers"), []);
  const health = useLoad(() => get<Health>("/api/integrations/health"), []);
  const [status, setStatus] = useState<HandoverStatus | "">("");
  const [project, setProject] = useState("");
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  usePageTitle("Manager dashboard");

  const managed = useMemo(() => (handovers.data ?? []).filter((h) => h.myRoles.includes("manager")), [handovers.data]);
  const filtered = managed.filter(
    (h) =>
      (!status || h.status === status) &&
      (!project || h.project.id === project) &&
      (!query || `${h.project.name} ${h.project.clientName} ${h.outgoing.displayName} ${h.incoming?.displayName ?? ""}`.toLowerCase().includes(query.toLowerCase())),
  );

  const metrics = useMemo(() => {
    const active = managed.filter((h) => h.status !== "approved" && h.status !== "cancelled");
    const gaps = new Map<string, number>();
    for (const h of active) for (const s of h.missingSections) gaps.set(s, (gaps.get(s) ?? 0) + 1);
    return {
      active: active.length,
      awaiting: managed.filter((h) => h.status === "submitted").length,
      overdue: managed.filter((h) => h.overdue).length,
      approved: managed.filter((h) => h.status === "approved").length,
      publishFailures: managed.filter((h) => h.publication?.status === "failed").length,
      gaps: [...gaps.entries()].sort((a, b) => b[1] - a[1]),
    };
  }, [managed]);

  const projects = [...new Map(managed.map((h) => [h.project.id, h.project])).values()];

  return (
    <>
      <div className="page-head">
        <div>
          <span className="eyebrow">Manager dashboard</span>
          <h1>Knowledge transfers</h1>
        </div>
        <button className="btn btn-primary" onClick={() => setCreating((v) => !v)} aria-expanded={creating}>
          {creating ? "Close" : "New handover assignment"}
        </button>
      </div>

      {creating && <NewAssignment onCreated={() => { setCreating(false); void handovers.reload(); }} />}

      {handovers.loading && !handovers.data ? (
        <Spinner />
      ) : handovers.error ? (
        <ErrorAlert error={handovers.error} title="Could not load handovers" />
      ) : (
        <>
          <div className="metrics" aria-label="Summary">
            <Metric label="Active handovers" value={metrics.active} />
            <Metric label="Awaiting your review" value={metrics.awaiting} tone={metrics.awaiting ? "info" : undefined} />
            <Metric label="Overdue" value={metrics.overdue} tone={metrics.overdue ? "danger" : undefined} />
            <Metric label="Approved" value={metrics.approved} tone="ok" />
            <Metric label="Publishing failures" value={metrics.publishFailures} tone={metrics.publishFailures ? "danger" : undefined} />
          </div>

          <div className="split">
            <div className="stack" style={{ gap: 20, minWidth: 0 }}>
              <div className="card-head">
                <h2>Handovers</h2>
                <div className="row">
                  <label className="visually-hidden" htmlFor="flt-q">Search</label>
                  <input id="flt-q" placeholder="Search project, client or person" value={query} onChange={(e) => setQuery(e.target.value)} style={{ width: 230 }} />
                  <label className="visually-hidden" htmlFor="flt-status">Status</label>
                  <select id="flt-status" value={status} onChange={(e) => setStatus(e.target.value as HandoverStatus | "")} style={{ width: "auto" }}>
                    <option value="">All statuses</option>
                    <option value="draft">Draft</option>
                    <option value="submitted">Awaiting review</option>
                    <option value="changes_requested">Changes requested</option>
                    <option value="approved">Approved</option>
                    <option value="cancelled">Cancelled</option>
                  </select>
                  <label className="visually-hidden" htmlFor="flt-project">Project</label>
                  <select id="flt-project" value={project} onChange={(e) => setProject(e.target.value)} style={{ width: "auto" }}>
                    <option value="">All projects</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>{p.code}</option>
                    ))}
                  </select>
                </div>
              </div>
              {filtered.length === 0 ? (
                <Empty title={managed.length ? "No handovers match these filters" : "No handovers yet"}>
                  {managed.length ? "Clear a filter to see more." : "Create a handover assignment to start capturing knowledge."}
                </Empty>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Project</th>
                        <th>People</th>
                        <th>Status</th>
                        <th>Completeness</th>
                        <th>Due</th>
                        <th>SharePoint</th>
                        <th><span className="visually-hidden">Actions</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map((h) => (
                        <tr key={h.id}>
                          <td>
                            <strong>{h.project.name}</strong>
                            <div className="muted">{h.project.code} · {h.project.clientName}</div>
                          </td>
                          <td>
                            <span className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
                              <Avatar name={h.outgoing.displayName} size="sm" />
                              <span>{h.outgoing.displayName} → {h.incoming?.displayName ?? <span className="muted">not assigned</span>}</span>
                            </span>
                          </td>
                          <td><StatusChip status={h.status} /></td>
                          <td style={{ minWidth: 130 }}>
                            {h.completenessPercent === null ? "-" : (
                              <div className="stack" style={{ gap: 4 }}>
                                <span className="num">{h.completenessPercent}%</span>
                                <Progress value={h.completenessPercent} label={`${h.project.name} completeness`} />
                              </div>
                            )}
                          </td>
                          <td className="num">
                            {formatDate(h.transferDueDate)}
                            {h.overdue && <div><Chip tone="danger">Overdue</Chip></div>}
                          </td>
                          <td>{h.status === "approved" ? <PublicationChip pub={h.publication} /> : <span className="muted">-</span>}</td>
                          <td>
                            <Link className={`btn btn-sm${h.status === "submitted" ? " btn-primary" : ""}`} to={`/review/${h.id}`}>
                              {h.status === "submitted" ? "Review" : "Open"}
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <aside className="stack">
              <div className="card">
                <h3>Most common missing sections</h3>
                {metrics.gaps.length === 0 ? (
                  <p className="small muted">No required sections are missing on active handovers.</p>
                ) : (
                  <ul className="stack small" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                    {metrics.gaps.map(([s, n]) => (
                      <li key={s} className="row" style={{ justifyContent: "space-between" }}>
                        <span>{SECTION_TITLE[s] ?? s}</span>
                        <span className="num muted">{n} handover{n > 1 ? "s" : ""}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <IntegrationCard health={health.data} error={health.error} onRefresh={() => void health.reload()} />
            </aside>
          </div>
        </>
      )}
    </>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: "ok" | "danger" | "info" }) {
  return (
    <div className="metric">
      <span className="small muted">{label}</span>
      <strong style={tone ? { color: `var(--${tone})` } : undefined}>{value}</strong>
    </div>
  );
}

function IntegrationCard({ health, error, onRefresh }: { health: Health | null; error: unknown; onRefresh: () => void }) {
  return (
    <div className="card">
      <div className="card-head">
        <h3>Integrations</h3>
        <button className="btn btn-sm btn-ghost" onClick={onRefresh}>Refresh</button>
      </div>
      <ErrorAlert error={error} />
      {health && (
        <div className="stack small">
          <div className="stack" style={{ gap: 4 }}>
            <span className="row">
              <strong>SharePoint</strong>
              {health.sharepoint.simulated ? <Chip tone="warn">Simulated</Chip> : health.sharepoint.ok ? <Chip tone="ok">Connected</Chip> : <Chip tone="danger">Error</Chip>}
            </span>
            <span className="muted">{health.sharepoint.detail}</span>
            <span className="muted">
              Publications: {health.publications.synced ?? 0} synced · {health.publications.pending ?? 0} pending · {health.publications.failed ?? 0} failed
            </span>
            <span className="muted">Checked {formatDateTime(health.sharepoint.checkedAt)}</span>
          </div>
          <div className="stack" style={{ gap: 4 }}>
            <span className="row">
              <strong>Assistant</strong>
              <Chip tone={health.assistant.generative ? "ok" : "warn"}>{health.assistant.generative ? "LLM" : "Extractive only"}</Chip>
            </span>
            <span className="muted">{health.assistant.label}</span>
          </div>
          <div className="stack" style={{ gap: 4 }}>
            <span className="row"><strong>Email</strong><Chip tone="neutral">Not configured</Chip></span>
            <span className="muted">{health.email.detail}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// --- new assignment ------------------------------------------------------------------

function UserPicker({ id, label, value, onChange, exclude }: { id: string; label: string; value: Person | null; onChange: (p: Person | null) => void; exclude?: string[] }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Person[]>([]);
  useEffect(() => {
    if (value) return;
    const t = window.setTimeout(() => {
      get<Person[]>(`/api/users?query=${encodeURIComponent(q)}`).then(setResults, () => setResults([]));
    }, 200);
    return () => window.clearTimeout(t);
  }, [q, value]);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {value ? (
        <div className="row">
          <span>{value.displayName} <span className="muted small">{value.email}</span></span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => onChange(null)}>Change</button>
        </div>
      ) : (
        <>
          <input id={id} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or email" autoComplete="off" />
          <div className="row">
            {results.filter((r) => !exclude?.includes(r.id)).slice(0, 6).map((r) => (
              <button type="button" key={r.id} className="btn btn-sm" onClick={() => onChange(r)}>{r.displayName}</button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function NewAssignment({ onCreated }: { onCreated: () => void }) {
  const navigate = useNavigate();
  const projects = useLoad(() => get<Project[]>("/api/projects"), []);
  const [projectId, setProjectId] = useState("");
  const [newProject, setNewProject] = useState({ code: "", name: "", clientName: "", description: "" });
  const [outgoing, setOutgoing] = useState<Person | null>(null);
  const [incoming, setIncoming] = useState<Person | null>(null);
  const [due, setDue] = useState("");
  const [start, setStart] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const toast = useToast();

  const managedProjects = (projects.data ?? []).filter((p) => p.myRoles.includes("manager"));
  const creatingProject = projectId === "__new";

  return (
    <form
      className="card"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          let pid = projectId;
          if (creatingProject) pid = (await post<Project>("/api/projects", newProject)).id;
          const h = await post<Handover>("/api/handovers", {
            projectId: pid,
            outgoingUserId: outgoing?.id,
            incomingUserId: incoming?.id,
            transferDueDate: due,
            onboardingStartDate: start || undefined,
          });
          onCreated();
          toast(`Assignment created. ${outgoing?.displayName} can start the handover now.`);
          navigate(`/review/${h.id}`);
        } catch (err) {
          setError(err);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2>New handover assignment</h2>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="na-project">Project</label>
          <select id="na-project" required value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">Select a project</option>
            {managedProjects.map((p) => (
              <option key={p.id} value={p.id}>{p.code} · {p.name}</option>
            ))}
            <option value="__new">Create a new project…</option>
          </select>
        </div>
        {creatingProject && (
          <>
            <div className="field">
              <label htmlFor="np-code">Project code</label>
              <input id="np-code" required value={newProject.code} onChange={(e) => setNewProject({ ...newProject, code: e.target.value.toUpperCase() })} placeholder="e.g. ATLAS" />
            </div>
            <div className="field">
              <label htmlFor="np-name">Project name</label>
              <input id="np-name" required value={newProject.name} onChange={(e) => setNewProject({ ...newProject, name: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="np-client">Client</label>
              <input id="np-client" required value={newProject.clientName} onChange={(e) => setNewProject({ ...newProject, clientName: e.target.value })} />
            </div>
          </>
        )}
        <UserPicker id="na-out" label="Outgoing employee" value={outgoing} onChange={setOutgoing} exclude={incoming ? [incoming.id] : []} />
        <UserPicker id="na-in" label="Incoming employee (optional)" value={incoming} onChange={setIncoming} exclude={outgoing ? [outgoing.id] : []} />
        <div className="field">
          <label htmlFor="na-due">Transfer deadline</label>
          <input id="na-due" type="date" required value={due} onChange={(e) => setDue(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="na-start">Onboarding start date</label>
          <input id="na-start" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        </div>
      </div>
      <ErrorAlert error={error} />
      <div className="row">
        <button className="btn btn-primary" type="submit" disabled={busy || !projectId || !outgoing || !due}>
          {busy ? "Creating…" : "Create assignment"}
        </button>
        <span className="small muted">The outgoing employee sees the handover on their home page right away.</span>
      </div>
    </form>
  );
}
