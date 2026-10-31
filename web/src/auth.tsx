import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { get, post, setCsrfToken, setUnauthenticatedHandler } from "./api";
import type { SystemStatus, User } from "./types";

interface AuthState {
  user: User | null;
  status: SystemStatus | null;
  ready: boolean;
  demoLogin(email: string): Promise<void>;
  /** Demo mode: end the current session and sign in as another synthetic persona. */
  switchPersona(email: string): Promise<void>;
  logout(): Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [ready, setReady] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await get<SystemStatus>("/api/system/status"));
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    setUnauthenticatedHandler(() => setUser(null));
    get<{ user: User; csrfToken: string }>("/api/auth/session")
      .then(async (s) => {
        setCsrfToken(s.csrfToken);
        setUser(s.user);
        await loadStatus();
      })
      .catch(() => setUser(null))
      .finally(() => setReady(true));
  }, [loadStatus]);

  const demoLogin = async (email: string) => {
    const s = await post<{ user: User; csrfToken: string }>("/api/auth/demo-login", { email });
    setCsrfToken(s.csrfToken);
    setUser(s.user);
    await loadStatus();
  };

  const switchPersona = async (email: string) => {
    await post("/api/auth/logout").catch(() => undefined);
    await demoLogin(email);
  };

  const logout = async () => {
    await post("/api/auth/logout").catch(() => undefined);
    setUser(null);
  };

  return <Ctx.Provider value={{ user, status, ready, demoLogin, switchPersona, logout }}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth outside AuthProvider");
  return v;
}
