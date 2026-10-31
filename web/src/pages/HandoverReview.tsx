import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { get, post } from "../api";
import { HandoverView } from "../components/HandoverView";
import { Avatar, Chip, ErrorAlert, LoadError, formatDate, formatDateTime, Progress, PublicationChip, Spinner, StatusChip, useLoad, usePageTitle, useToast } from "../components/ui";
import type { Handover } from "../types";

/** Manager view of a handover: review, decide, and follow publication to SharePoint. */
export function HandoverReview() {
  const { id } = useParams();
  const { data: h, error, loading, reload, setData } = useLoad(() => get<Handover>(`/api/handovers/${id}`), [id]);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [confirming, setConfirming] = useState<"approve" | "cancel" | null>(null);
  const toast = useToast();
  usePageTitle(h ? `Review: ${h.project.name}` : "Review");

  if (loading && !h) return <Spinner label="Loading handover" />;
  if (error) return <LoadError error={error} what="handover" />;
  if (!h) return null;

  const act = async (action: "approve" | "request-changes" | "cancel" | "retry-publication") => {
    setBusy(action);
    setActionError(null);
    try {
      const body = action === "retry-publication" ? {} : { comment };
      const res = await post<Handover>(`/api/handovers/${h.id}/${action}`, body);
      if (action === "retry-publication") {
        await reload();
        toast("Publishing queued again");
      } else {
        setData(res);
        setComment("");
        toast(action === "approve" ? `Approved version ${res.approvedVersion}. Publishing to SharePoint…` : action === "cancel" ? "Handover cancelled" : `Changes requested from ${h.outgoing.displayName}`);
      }
      setConfirming(null);
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(null);
    }
  };

  const content = h.submittedContent ?? h.approvedContent ?? h.content;
  const canDecide = h.allowedActions.includes("approve");
  const isManager = h.myRoles.includes("manager");

  return (
    <>
      <div className="page-head">
        <div>
          <span className="eyebrow">Handover review · {h.project.code}</span>
          <h1>{h.project.name}</h1>
          <div className="row small muted">
            <StatusChip status={h.status} />
            <span className="row" style={{ gap: 6 }}><Avatar name={h.outgoing.displayName} size="sm" />{h.outgoing.displayName}</span>
            {h.incoming && <span>Incoming: {h.incoming.displayName}</span>}
            <span>Transfer due {formatDate(h.transferDueDate)}</span>
          </div>
        </div>
        <Link to="/manager" className="btn">Back to dashboard</Link>
      </div>

      <div className="split">
        <div className="stack reading" style={{ gap: 28 }}>
          <div className="card-head">
            <h2>{h.status === "draft" || h.status === "changes_requested" ? "Working draft" : `Version ${h.currentVersion}`}</h2>
            {h.submittedAt && <span className="small muted">Submitted {formatDateTime(h.submittedAt)} · author attested {formatDateTime(h.authorAttestedAt)}</span>}
          </div>
          {h.status === "draft" && <div className="alert alert-info">{h.outgoing.displayName} is still writing this handover. You can follow progress, but it cannot be approved until it is submitted.</div>}
          {content ? <HandoverView content={content} /> : <p className="muted">No content yet.</p>}
        </div>

        <aside>
          {h.completeness && (
            <div className="card">
              <div className="card-head">
                <h3>Draft completeness</h3>
                <strong className="num">{h.completeness.percent}%</strong>
              </div>
              <Progress value={h.completeness.percent} label="Completeness" />
              {h.completeness.missing.length > 0 && <p className="small muted">Missing: {h.completeness.missing.map((m) => m.label).join(", ")}</p>}
              <p className="small muted">
                {h.completeness.provenance.confirmed} confirmed · {h.completeness.provenance.reported} reported · {h.completeness.provenance.assumption} assumptions · {h.completeness.provenance.open_question} open questions
              </p>
            </div>
          )}

          {canDecide && (
            <div className="card">
              <h3>Decision</h3>
              <div className="field">
                <label htmlFor="review-comment">Comment for {h.outgoing.displayName}</label>
                <textarea id="review-comment" rows={4} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Required when requesting changes" />
              </div>
              <ErrorAlert error={actionError} />
              {confirming === "approve" ? (
                <div className="confirm" role="group" aria-label="Confirm approval">
                  <strong>Approve version {h.currentVersion}?</strong>
                  <span className="small muted">It becomes read-only, is published to SharePoint and is shared with {h.incoming?.displayName ?? "the incoming employee"}. This cannot be undone.</span>
                  <div className="row">
                    <button className="btn btn-primary btn-sm" disabled={busy !== null} onClick={() => void act("approve")}>{busy === "approve" ? "Approving…" : "Yes, approve and publish"}</button>
                    <button className="btn btn-sm" onClick={() => setConfirming(null)}>Go back</button>
                  </div>
                </div>
              ) : (
                <div className="row">
                  <button className="btn btn-primary" disabled={busy !== null} onClick={() => setConfirming("approve")}>Approve & publish</button>
                  <button className="btn" disabled={busy !== null || comment.trim().length < 5} onClick={() => void act("request-changes")} title={comment.trim().length < 5 ? "Write a comment first" : undefined}>
                    {busy === "request-changes" ? "Sending…" : "Request changes"}
                  </button>
                </div>
              )}
              {comment.trim().length < 5 && <span className="small muted">To request changes, write at least a sentence explaining what to fix.</span>}
              <p className="small muted">Approving freezes version {h.currentVersion}, publishes it to SharePoint and makes it available to {h.incoming?.displayName ?? "the incoming employee"}.</p>
            </div>
          )}

          {h.allowedActions.includes("cancel") && !canDecide && (
            <div className="card">
              <h3>Cancel assignment</h3>
              <div className="field">
                <label htmlFor="cancel-reason">Reason</label>
                <textarea id="cancel-reason" rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />
              </div>
              <ErrorAlert error={actionError} />
              {confirming === "cancel" ? (
                <div className="confirm" role="group" aria-label="Confirm cancellation">
                  <strong>Cancel this handover?</strong>
                  <span className="small muted">{h.outgoing.displayName} will no longer be able to edit or submit it.</span>
                  <div className="row">
                    <button className="btn btn-danger btn-sm" disabled={busy !== null} onClick={() => void act("cancel")}>Yes, cancel handover</button>
                    <button className="btn btn-sm" onClick={() => setConfirming(null)}>Keep it</button>
                  </div>
                </div>
              ) : (
                <button className="btn btn-danger" disabled={busy !== null || comment.trim().length < 5} onClick={() => setConfirming("cancel")}>
                  Cancel this handover
                </button>
              )}
            </div>
          )}

          {h.approvedVersion && (
            <div className="card">
              <div className="card-head">
                <h3>SharePoint</h3>
                <PublicationChip pub={h.publication} />
              </div>
              {h.publication && (
                <div className="stack small">
                  {h.publication.remotePath && <span>Path: <code>{h.publication.remotePath}</code></span>}
                  {h.publication.webUrl?.startsWith("https://") && <a href={h.publication.webUrl} target="_blank" rel="noreferrer">Open in SharePoint</a>}
                  {h.publication.adapterMode === "mock" && <span className="muted">Stored in the local mock SharePoint store. No Microsoft 365 document exists.</span>}
                  <span className="muted">Attempts: {h.publication.attempts}{h.publication.syncedAt ? ` · synced ${formatDateTime(h.publication.syncedAt)}` : ""}</span>
                  {h.publication.metadataStatus === "failed" && <span className="muted">Document stored, but metadata columns could not be set.</span>}
                  {h.publication.lastError && <span style={{ color: "var(--danger)" }}>Last error: {h.publication.lastError}</span>}
                  {h.publication.status === "failed" && isManager && (
                    <button className="btn btn-sm" disabled={busy !== null} onClick={() => void act("retry-publication")}>Retry publishing</button>
                  )}
                  {h.publication.status === "pending" && <button className="btn btn-sm" onClick={() => void reload()}>Refresh status</button>}
                </div>
              )}
            </div>
          )}

          <div className="card">
            <h3>History</h3>
            {h.versions.length === 0 ? (
              <p className="small muted">Not submitted yet.</p>
            ) : (
              <ul className="stack small" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {h.versions.map((v) => (
                  <li key={v.version} className="stack" style={{ gap: 2 }}>
                    <span className="row">
                      <strong>Version {v.version}</strong>
                      {v.decision === "approved" && <Chip tone="ok">Approved</Chip>}
                      {v.decision === "changes_requested" && <Chip tone="warn">Changes requested</Chip>}
                      {!v.decision && <Chip tone="info">Pending</Chip>}
                    </span>
                    <span className="muted">Submitted {formatDateTime(v.submittedAt)} by {v.submittedBy.displayName}</span>
                    {v.decidedAt && <span className="muted">Decided {formatDateTime(v.decidedAt)} by {v.decidedBy?.displayName}</span>}
                  </li>
                ))}
              </ul>
            )}
            {h.reviewComment && <p className="small"><strong>Last comment:</strong> {h.reviewComment}</p>}
          </div>
        </aside>
      </div>
    </>
  );
}
