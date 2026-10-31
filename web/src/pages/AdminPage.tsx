import { useState } from "react";
import { get } from "../api";
import { Chip, Empty, ErrorAlert, formatDateTime, Spinner, useLoad, usePageTitle } from "../components/ui";

interface AuditEvent {
  id: string;
  occurredAt: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  projectId: string | null;
  outcome: "success" | "denied" | "failure";
  details: Record<string, unknown> | null;
}

interface Health {
  sharepoint: { mode: string; simulated: boolean; ok: boolean; detail: string };
  jobs: { type: string; status: string; n: number }[];
  recentJobFailures: { id: string; type: string; status: string; attempts: number; last_error: string; updated_at: string }[];
}

const PAGE = 50;

export function AdminPage() {
  const [offset, setOffset] = useState(0);
  usePageTitle("Administration");
  const audit = useLoad(() => get<AuditEvent[]>(`/api/admin/audit?limit=${PAGE}&offset=${offset}`), [offset]);
  const health = useLoad(() => get<Health>("/api/integrations/health"), []);

  return (
    <>
      <div className="page-head">
        <div>
          <span className="eyebrow">Administration</span>
          <h1>Audit & integration health</h1>
          <p className="muted small">Administrators see configuration and audit data. Project content stays limited to project members.</p>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Background jobs</h2>
          <button className="btn btn-sm btn-ghost" onClick={() => void health.reload()}>Refresh</button>
        </div>
        <ErrorAlert error={health.error} />
        {health.data && (
          <>
            <p className="small">
              SharePoint: <strong>{health.data.sharepoint.mode}</strong> {health.data.sharepoint.simulated && <Chip tone="warn">Simulated</Chip>} - {health.data.sharepoint.detail}
            </p>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Job type</th><th>Status</th><th>Count</th></tr></thead>
                <tbody>
                  {health.data.jobs.map((j) => (
                    <tr key={j.type + j.status}><td><code>{j.type}</code></td><td>{j.status}</td><td className="num">{j.n}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            {health.data.recentJobFailures.length > 0 && (
              <>
                <h3>Recent job errors</h3>
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>When</th><th>Type</th><th>Status</th><th>Attempts</th><th>Error</th></tr></thead>
                    <tbody>
                      {health.data.recentJobFailures.map((f) => (
                        <tr key={f.id}><td>{formatDateTime(f.updated_at)}</td><td><code>{f.type}</code></td><td>{f.status}</td><td className="num">{f.attempts}</td><td>{f.last_error}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}
      </div>

      <div className="card">
        <h2>Audit log</h2>
        {audit.loading && !audit.data ? (
          <Spinner />
        ) : audit.error ? (
          <ErrorAlert error={audit.error} />
        ) : (audit.data ?? []).length === 0 ? (
          <Empty title="No audit events" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>When</th><th>Action</th><th>Outcome</th><th>Actor</th><th>Entity</th><th>Details</th></tr></thead>
              <tbody>
                {audit.data!.map((e) => (
                  <tr key={e.id}>
                    <td className="num" style={{ whiteSpace: "nowrap" }}>{formatDateTime(e.occurredAt)}</td>
                    <td><code>{e.action}</code></td>
                    <td><Chip tone={e.outcome === "success" ? "ok" : e.outcome === "denied" ? "warn" : "danger"}>{e.outcome}</Chip></td>
                    <td className="mono small">{e.actorId?.slice(0, 8) ?? "system"}</td>
                    <td className="small">{e.entityType}{e.entityId ? ` ${e.entityId.slice(0, 8)}` : ""}</td>
                    <td className="mono small" style={{ maxWidth: 360, overflowWrap: "anywhere" }}>{e.details ? JSON.stringify(e.details) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="row">
          <button className="btn btn-sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Newer</button>
          <button className="btn btn-sm" disabled={(audit.data?.length ?? 0) < PAGE} onClick={() => setOffset(offset + PAGE)}>Older</button>
        </div>
      </div>
    </>
  );
}
