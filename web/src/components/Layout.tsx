import { useEffect, useRef } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth";
import { DemoGuide, PersonaSwitcher } from "./DemoGuide";
import { Avatar } from "./ui";

export function Layout() {
  const { user, status, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const main = useRef<HTMLElement>(null);
  const firstRender = useRef(true);

  // Move focus to the new page on navigation so keyboard and screen-reader users start at the top.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    main.current?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [location.pathname]);

  if (!user) return null;
  const demo = Boolean(status?.auth.simulated);
  const simulated: string[] = [];
  if (status?.auth.simulated) simulated.push("demo sign-in");
  if (status?.sharepoint.simulated) simulated.push("mock SharePoint");
  if (status && !status.assistant.generative) simulated.push("extractive assistant (no generative AI)");

  return (
    <>
      <a className="skip-link" href="#main">Skip to content</a>
      <header className="topbar">
        <div className="topbar-inner">
          <NavLink to="/" className="brand" aria-label="Knowledge Transfer home">Knowledge Transfer</NavLink>
          <nav className="nav" aria-label="Main">
            <NavLink to="/" end>Home</NavLink>
            {user.isManager && <NavLink to="/manager">Manager dashboard</NavLink>}
            {user.isAdmin && <NavLink to="/admin">Administration</NavLink>}
          </nav>
          <div className="user-menu">
            <Avatar name={user.displayName} />
            {demo ? (
              <PersonaSwitcher />
            ) : (
              <span className="small" style={{ display: "grid", lineHeight: 1.3 }}>
                <span>{user.displayName}</span>
                <span className="muted">{user.email}</span>
              </span>
            )}
            <button
              className="btn btn-sm"
              onClick={async () => {
                await logout();
                navigate("/", { replace: true });
              }}
            >
              Sign out
            </button>
          </div>
        </div>
      </header>
      {simulated.length > 0 && (
        <div className="mode-banner" role="note">
          <div>
            <strong>Demo mode</strong>
            <span>Synthetic data. Simulated: {simulated.join(", ")}.</span>
          </div>
        </div>
      )}
      <main className="page" id="main" ref={main} tabIndex={-1}>
        {/* Keyed by user so switching persona remounts pages instead of showing the previous persona's data. */}
        <Outlet key={user.id} />
      </main>
      {demo && <DemoGuide />}
    </>
  );
}
