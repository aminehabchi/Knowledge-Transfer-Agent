import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { get } from "../api";
import { useAuth } from "../auth";
import { DEMO_PERSONAS, personaByEmail } from "../demo";
import { Avatar, ErrorAlert, Spinner, usePageTitle } from "../components/ui";

interface AuthConfig {
  mode: "demo" | "entra";
  demoUsers: { email: string; displayName: string; isManager: boolean; isAdmin: boolean }[];
}

const ERRORS: Record<string, string> = {
  signin_failed: "Sign-in with Microsoft failed. Try again or contact your administrator.",
  not_provisioned: "Your account is not set up in this application yet. Ask an administrator to add you.",
};

const order = (email: string) => {
  const i = DEMO_PERSONAS.findIndex((p) => p.email === email);
  return i === -1 ? 99 : i;
};

export function Login() {
  const { demoLogin } = useAuth();
  const [cfg, setCfg] = useState<AuthConfig | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [params] = useSearchParams();
  const navigate = useNavigate();
  usePageTitle("Sign in");

  useEffect(() => {
    get<AuthConfig>("/api/auth/config").then(setCfg, setError);
  }, []);

  const urlError = params.get("error");

  return (
    <div className="login">
      <div className="login-box">
        <div className="stack" style={{ gap: 14 }}>
          <span className="brand">Knowledge Transfer</span>
          <h1>Sign in</h1>
          <p className="lede">Hand over projects without losing what only one person knows.</p>
        </div>
        {urlError && <div className="alert alert-error" role="alert">{ERRORS[urlError] ?? "Sign-in failed."}</div>}
        <ErrorAlert error={error} />
        {!cfg && !error && <Spinner />}
        {cfg?.mode === "entra" && (
          <a className="btn btn-ink" href="/api/auth/login?returnTo=/" style={{ justifySelf: "start" }}>
            Sign in with Microsoft
          </a>
        )}
        {cfg?.mode === "demo" && (
          <div className="stack" style={{ gap: 16 }}>
            <div className="alert alert-warn">
              <strong>Demo sign-in</strong>
              <span>Personas are listed in demo order: start with Omar. You can switch persona any time from the top bar. Production uses Microsoft Entra ID.</span>
            </div>
            {cfg.demoUsers.length === 0 && <p className="muted">No demo users exist yet. Run <code>npm run seed</code>.</p>}
            <div role="list">
              {[...cfg.demoUsers]
                .sort((a, b) => order(a.email) - order(b.email))
                .map((u) => (
                <button
                  key={u.email}
                  role="listitem"
                  className="persona"
                  disabled={busy !== null}
                  onClick={async () => {
                    setBusy(u.email);
                    setError(null);
                    try {
                      await demoLogin(u.email);
                      // Start from home: the previous URL may belong to another persona's work.
                      navigate("/", { replace: true });
                    } catch (e) {
                      setError(e);
                      setBusy(null);
                    }
                  }}
                >
                  <Avatar name={u.displayName} />
                  <span style={{ display: "grid", gap: 2 }}>
                    <span style={{ fontWeight: 600 }}>{u.displayName}</span>
                    <span className="muted small">
                      {personaByEmail(u.email) ? `${personaByEmail(u.email)!.role} · ${personaByEmail(u.email)!.story}` : u.email}
                    </span>
                  </span>
                  {busy === u.email ? <span className="spinner" aria-label="Signing in" /> : <span className="muted" aria-hidden="true">→</span>}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
