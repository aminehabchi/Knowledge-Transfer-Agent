import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { get } from "../api";
import { useAuth } from "../auth";
import { DEMO_PERSONAS, personaByEmail, type DemoState } from "../demo";
import { Avatar, useToast } from "./ui";

const COLLAPSE_KEY = "kta.demoGuide.collapsed";

const readCollapsed = () => {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
};

interface Step {
  title: string;
  detail: string;
  persona: string;
  to: (st: DemoState) => string;
  done: (st: DemoState) => boolean;
}

const STEPS: Step[] = [
  {
    title: "Complete and submit the handover",
    detail: "Answer the two follow-up questions (use “Insert example answer”), then submit from Review & submit.",
    persona: "omar.haddad@example.com",
    to: (st) => `/handovers/${st.handoverId}`,
    done: (st) => st.handoverStatus === "submitted" || st.handoverStatus === "approved",
  },
  {
    title: "Review and approve",
    detail: "Read the submission, check completeness and provenance, then approve and publish.",
    persona: "maya.chen@example.com",
    to: (st) => `/review/${st.handoverId}`,
    done: (st) => st.handoverStatus === "approved",
  },
  {
    title: "Publish to SharePoint",
    detail: "Approval queues a background job that publishes the handover and indexes it.",
    persona: "maya.chen@example.com",
    to: (st) => `/review/${st.handoverId}`,
    done: (st) => st.publicationStatus === "synced",
  },
  {
    title: "Ask the onboarding assistant",
    detail: "Ask “Who should I contact when something goes wrong?”: the answer now cites the approved handover.",
    persona: "lina.park@example.com",
    to: (st) => `/projects/${st.projectId}`,
    done: (st) => Boolean(st.askedAfterApproval),
  },
  {
    title: "Show the audit trail",
    detail: "Every assignment, approval, publication and question is recorded, including denied access attempts.",
    persona: "theo.martin@example.com",
    to: () => "/admin",
    done: () => false,
  },
];

/** Floating presenter script for the synthetic demo: shows where the story is and jumps to the next scene. */
export function DemoGuide() {
  const { user, switchPersona } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const [state, setState] = useState<DemoState | null>(null);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [busy, setBusy] = useState<number | null>(null);

  const refresh = useCallback(() => {
    get<DemoState>("/api/demo/state").then(setState, () => setState(null));
  }, []);

  // Refresh on every page change and every few seconds (background publishing finishes on its own).
  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, 4000);
    return () => window.clearInterval(t);
  }, [refresh, location.pathname, user?.id]);

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
    } catch {
      /* storage unavailable: keep the in-memory state */
    }
  }, [collapsed]);

  const visible = Boolean(state?.available && state.handoverId);
  // While the guide is open, wide screens reserve a column for it so it never covers page content.
  useEffect(() => {
    document.body.classList.toggle("with-guide", visible && !collapsed);
    return () => document.body.classList.remove("with-guide");
  }, [visible, collapsed]);

  if (!state?.available || !state.handoverId) return null;
  const current = STEPS.findIndex((s) => !s.done(state));

  const go = async (i: number) => {
    const step = STEPS[i]!;
    setBusy(i);
    try {
      if (user?.email !== step.persona) {
        await switchPersona(step.persona);
        toast(`Now viewing as ${personaByEmail(step.persona)?.name}`);
      }
      navigate(step.to(state));
    } catch {
      toast("Could not switch persona", "error");
    } finally {
      setBusy(null);
    }
  };

  if (collapsed) {
    return (
      <button className="demo-guide-tab" onClick={() => setCollapsed(false)} aria-expanded="false">
        Demo script · step {Math.min(current + 1, STEPS.length)} of {STEPS.length}
      </button>
    );
  }

  return (
    <aside className="demo-guide" aria-label="Demo script">
      <div className="demo-guide-head">
        <strong>Demo script</strong>
        <button className="btn btn-ghost btn-sm" onClick={() => setCollapsed(true)} aria-expanded="true">Hide</button>
      </div>
      <ol>
        {STEPS.map((step, i) => {
          const done = step.done(state);
          const isCurrent = i === current;
          const persona = personaByEmail(step.persona)!;
          return (
            <li key={step.title} className={`demo-step${done ? " done" : ""}${isCurrent ? " current" : ""}`} aria-current={isCurrent ? "step" : undefined}>
              <span className="demo-step-num" aria-hidden="true">{done ? "✓" : i + 1}</span>
              <div className="demo-step-body">
                <span className="demo-step-title">{step.title}</span>
                {isCurrent && <span className="demo-step-detail">{step.detail}</span>}
                <span className="demo-step-who">
                  <Avatar name={persona.name} size="sm" /> {persona.name}
                </span>
              </div>
              {(isCurrent || (!done && i > current)) && (
                <button className={`btn btn-sm ${isCurrent ? "btn-primary" : ""}`} disabled={busy !== null} onClick={() => void go(i)}>
                  {busy === i ? "…" : "Go"}
                </button>
              )}
              {done && (
                <button className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => void go(i)} aria-label={`Revisit: ${step.title}`}>
                  View
                </button>
              )}
            </li>
          );
        })}
      </ol>
      <p className="small muted">To start over, run <code>npm run seed -- --reset</code>.</p>
    </aside>
  );
}

/** Top-bar persona switcher, demo mode only. */
export function PersonaSwitcher() {
  const { user, switchPersona } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!user) return null;
  return (
    <label className="persona-switch">
      <span className="visually-hidden">Viewing as</span>
      <span className="small muted" aria-hidden="true">Viewing as</span>
      <select
        value={user.email}
        disabled={busy}
        onChange={async (e) => {
          const email = e.target.value;
          setBusy(true);
          try {
            await switchPersona(email);
            navigate("/", { replace: true });
            toast(`Now viewing as ${personaByEmail(email)?.name ?? email}`);
          } catch {
            toast("Could not switch persona", "error");
          } finally {
            setBusy(false);
          }
        }}
      >
        {DEMO_PERSONAS.map((p) => (
          <option key={p.email} value={p.email}>
            {p.name} · {p.role}
          </option>
        ))}
      </select>
    </label>
  );
}
