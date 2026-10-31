import { Link } from "react-router-dom";
import { get } from "../api";
import { useAuth } from "../auth";
import { Avatar, Empty, ErrorAlert, formatDate, Progress, Spinner, StatusChip, useLoad, usePageTitle } from "../components/ui";
import type { HandoverSummary, Project } from "../types";

const NEXT_STEP: Record<string, string> = {
  draft: "Continue handover",
  changes_requested: "Address review comments",
  submitted: "View submission",
  approved: "View approved handover",
  cancelled: "View handover",
};

/** Role-aware landing page: work to do as outgoing, onboarding as incoming, review as manager. */
export function Home() {
  const { user } = useAuth();
  usePageTitle("Home");
  const handovers = useLoad(() => get<HandoverSummary[]>("/api/handovers"), []);
  const projects = useLoad(() => get<Project[]>("/api/projects"), []);

  if (handovers.loading || projects.loading) return <Spinner />;
  const error = handovers.error ?? projects.error;
  if (error) return <ErrorAlert error={error} title="Could not load your work" />;

  const mine = (handovers.data ?? []).filter((h) => h.myRoles.includes("outgoing"));
  const onboarding = (projects.data ?? []).filter((p) => p.myRoles.includes("incoming"));
  const toReview = (handovers.data ?? []).filter((h) => h.myRoles.includes("manager") && h.status === "submitted");
  const firstName = user!.displayName.split(" ")[0];

  return (
    <div className="reading" style={{ display: "grid", gap: 56, maxWidth: 760 }}>
      <div className="stack" style={{ gap: 12 }}>
        <h1>Good to see you, {firstName}</h1>
        <p className="lede">
          {mine.some((h) => h.status === "draft" || h.status === "changes_requested")
            ? "You have a handover in progress. Every answer you write now saves your successor a question later."
            : onboarding.length
              ? "Your onboarding workspace is ready. Ask the assistant anything about the project; every answer links to its source."
              : toReview.length
                ? "Handovers are waiting for your review."
                : "Nothing needs your attention right now."}
        </p>
      </div>

      {user!.isManager && (
        <section className="stack" aria-labelledby="h-review">
          <div className="row section-title" style={{ justifyContent: "space-between" }}>
            <span id="h-review">Waiting for your review</span>
            <Link to="/manager" className="btn btn-ghost btn-sm">Open dashboard</Link>
          </div>
          {toReview.length === 0 ? (
            <p className="muted">No handovers are waiting for review.</p>
          ) : (
            <div className="feed">
              {toReview.map((h) => (
                <article className="feed-item" key={h.id}>
                  <div className="meta">
                    <Avatar name={h.outgoing.displayName} size="sm" />
                    <span>{h.outgoing.displayName}</span>
                    <span>{h.project.code}</span>
                  </div>
                  <h3><Link to={`/review/${h.id}`}>{h.project.name}</Link></h3>
                  <div className="row">
                    <Link className="btn btn-primary btn-sm" to={`/review/${h.id}`}>Review handover</Link>
                    <span className="small muted">Transfer due {formatDate(h.transferDueDate)}</span>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      <section className="stack" aria-labelledby="h-writing">
        <div className="section-title" id="h-writing">Handovers you are writing</div>
        {mine.length === 0 ? (
          <Empty title="No handovers assigned to you">When a manager asks you to hand over a project, it appears here.</Empty>
        ) : (
          <div className="feed">
            {mine.map((h) => (
              <article className="feed-item" key={h.id}>
                <div className="meta">
                  <span>{h.project.code}</span>
                  <span>{h.project.clientName}</span>
                  <StatusChip status={h.status} />
                </div>
                <h3><Link to={`/handovers/${h.id}`}>{h.project.name}</Link></h3>
                {h.completenessPercent !== null && (
                  <div className="stack" style={{ gap: 6, maxWidth: 360 }}>
                    <div className="row small muted" style={{ justifyContent: "space-between" }}>
                      <span>{h.completenessPercent}% complete</span>
                      {h.missingSections.length > 0 && <span>{h.missingSections.length} section(s) need work</span>}
                    </div>
                    <Progress value={h.completenessPercent} label={`${h.project.name} completeness`} />
                  </div>
                )}
                <div className="row">
                  <Link className="btn btn-primary btn-sm" to={`/handovers/${h.id}`}>{NEXT_STEP[h.status]}</Link>
                  <span className="small muted">
                    Due {formatDate(h.transferDueDate)}
                    {h.overdue && <strong style={{ color: "var(--danger)" }}> · overdue</strong>}
                    {h.incoming && ` · successor ${h.incoming.displayName}`}
                  </span>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="stack" aria-labelledby="h-joining">
        <div className="section-title" id="h-joining">Projects you are joining</div>
        {onboarding.length === 0 ? (
          <Empty title="No onboarding in progress">When you are assigned as the incoming employee on a project, it appears here.</Empty>
        ) : (
          <div className="feed">
            {onboarding.map((p) => (
              <article className="feed-item" key={p.id}>
                <div className="meta">
                  <span>{p.code}</span>
                  <span>{p.clientName}</span>
                </div>
                <h3><Link to={`/projects/${p.id}`}>{p.name}</Link></h3>
                <p className="excerpt">{p.description}</p>
                <Link className="btn btn-primary btn-sm" to={`/projects/${p.id}`} style={{ justifySelf: "start" }}>Open project workspace</Link>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
