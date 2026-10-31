import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "../api";
import type { HandoverStatus, Provenance, Publication } from "../types";

type Tone = "ok" | "warn" | "danger" | "info" | "accent" | "neutral";

export const Chip = ({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) => (
  <span className={`chip chip-${tone}`} title={title}>
    {children}
  </span>
);

const STATUS: Record<HandoverStatus, [Tone, string]> = {
  draft: ["neutral", "Draft"],
  submitted: ["info", "Awaiting review"],
  changes_requested: ["warn", "Changes requested"],
  approved: ["ok", "Approved"],
  cancelled: ["neutral", "Cancelled"],
};
export const StatusChip = ({ status }: { status: HandoverStatus }) => <Chip tone={STATUS[status][0]}>{STATUS[status][1]}</Chip>;

export const PROVENANCE: Record<Provenance, { tone: Tone; label: string; help: string }> = {
  confirmed: { tone: "ok", label: "Confirmed", help: "Backed by a referenced source" },
  reported: { tone: "info", label: "Reported", help: "Stated by the outgoing employee" },
  assumption: { tone: "warn", label: "Assumption", help: "Believed but not verified" },
  open_question: { tone: "danger", label: "Open question", help: "Unresolved - not a fact" },
};
export const ProvenanceChip = ({ p }: { p: Provenance }) => (
  <Chip tone={PROVENANCE[p].tone} title={PROVENANCE[p].help}>
    {PROVENANCE[p].label}
  </Chip>
);

export function PublicationChip({ pub }: { pub: Publication | null }) {
  if (!pub) return <Chip tone="neutral">Not published</Chip>;
  const where = pub.adapterMode === "mock" ? "mock SharePoint" : "SharePoint";
  if (pub.status === "synced") return <Chip tone="ok" title={pub.remotePath ?? ""}>{`Published to ${where}`}</Chip>;
  if (pub.status === "failed") return <Chip tone="danger" title={pub.lastError ?? ""}>Publishing failed</Chip>;
  return <Chip tone="warn" title={pub.lastError ?? ""}>{pub.lastError ? "Publishing - retrying" : "Publishing…"}</Chip>;
}

export const Spinner = ({ label = "Loading" }: { label?: string }) => (
  <div className="row muted" role="status">
    <span className="spinner" aria-hidden="true" />
    <span>{label}…</span>
  </div>
);

export function ErrorAlert({ error, title }: { error: unknown; title?: string }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : "Something went wrong.";
  const issues = error instanceof ApiError ? error.fieldIssues : [];
  return (
    <div className="alert alert-error" role="alert">
      <strong>{title ?? message}</strong>
      {title && <span>{message}</span>}
      {issues.length > 0 && (
        <ul>
          {issues.slice(0, 8).map((i) => (
            <li key={i.path + i.message}>
              {i.path ? <code>{i.path}</code> : null} {i.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Load failure for a page: 404s get a plain explanation and a way home; other errors show details. */
export function LoadError({ error, what }: { error: unknown; what: string }) {
  if (error instanceof ApiError && error.status === 404) {
    return (
      <div className="empty" role="alert">
        <strong>This {what} isn't available to you</strong>
        <span>It doesn't exist, or it belongs to a project or person you don't have access to.</span>
        <Link className="btn btn-sm" to="/" style={{ justifySelf: "start" }}>Go to your home page</Link>
      </div>
    );
  }
  return <ErrorAlert error={error} title={`Could not load this ${what}`} />;
}

export const Empty = ({ title, children }: { title: string; children?: ReactNode }) => (
  <div className="empty">
    <strong>{title}</strong>
    {children}
  </div>
);

export const Progress = ({ value, label }: { value: number; label: string }) => (
  <div className={`progress${value >= 100 ? " done" : ""}`} role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
    <span style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
  </div>
);

export const formatDate = (iso: string | null | undefined) => {
  if (!iso) return "-";
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
};
export const formatDateTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "-";

/** Loads data with explicit loading/error states and a reload function. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(load, deps);
  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await run());
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [run]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload, setData };
}

// --- people ------------------------------------------------------------------------

export const initials = (name: string) =>
  name
    .replace(/\(.*?\)/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

export const Avatar = ({ name, size }: { name: string; size?: "sm" }) => (
  <span className={`avatar${size ? ` ${size}` : ""}`} aria-hidden="true">{initials(name)}</span>
);

// --- page titles -------------------------------------------------------------------

/** Sets the browser tab title so history, tabs and screen readers name the current page. */
export function usePageTitle(title: string | null | undefined) {
  useEffect(() => {
    document.title = title ? `${title} · Knowledge Transfer` : "Knowledge Transfer";
  }, [title]);
}

// --- toasts --------------------------------------------------------------------------

interface Toast {
  id: number;
  text: string;
  kind: "ok" | "error";
}
const ToastCtx = createContext<(text: string, kind?: Toast["kind"]) => void>(() => {});

/** Short confirmations after an action ("Approved", "Submitted"), announced to screen readers. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const push = useCallback((text: string, kind: Toast["kind"] = "ok") => {
    const id = ++seq.current;
    setToasts((t) => [...t, { id, text, kind }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 7000 : 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.kind === "error" ? " error" : ""}`}>{t.text}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);
