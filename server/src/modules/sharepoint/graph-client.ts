import { IntegrationError } from "./types.ts";

export interface GraphCredentials {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

export interface GraphClientOptions {
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  baseUrl?: string;
  loginBaseUrl?: string;
  /** Attempts per request for transient failures before handing back to the job queue. */
  maxAttempts?: number;
  /** Longest Retry-After honoured inline; longer waits are delegated to the job queue. */
  maxInlineWaitMs?: number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Minimal Microsoft Graph client using the OAuth 2.0 client-credentials flow (application
 * permission, ideally `Sites.Selected`). Handles token caching/refresh, throttling (429/503 with
 * Retry-After), transient 5xx/network errors, and classifies permission failures as permanent.
 * Access tokens are never logged or included in error messages.
 */
export class GraphClient {
  private readonly creds: GraphCredentials;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly baseUrl: string;
  private readonly loginBaseUrl: string;
  private readonly maxAttempts: number;
  private readonly maxInlineWaitMs: number;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(creds: GraphCredentials, opts: GraphClientOptions = {}) {
    this.creds = creds;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.sleep = opts.sleep ?? realSleep;
    this.now = opts.now ?? Date.now;
    this.baseUrl = opts.baseUrl ?? "https://graph.microsoft.com/v1.0";
    this.loginBaseUrl = opts.loginBaseUrl ?? "https://login.microsoftonline.com";
    this.maxAttempts = opts.maxAttempts ?? 4;
    this.maxInlineWaitMs = opts.maxInlineWaitMs ?? 30_000;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt - 60_000 > this.now()) return this.token.value;
    let res: Response;
    try {
      res = await this.fetchFn(`${this.loginBaseUrl}/${encodeURIComponent(this.creds.tenantId)}/oauth2/v2.0/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.creds.clientId,
          client_secret: this.creds.clientSecret,
          grant_type: "client_credentials",
          scope: "https://graph.microsoft.com/.default",
        }),
      });
    } catch {
      throw new IntegrationError("Microsoft Entra token endpoint unreachable", { retryable: true });
    }
    if (!res.ok) {
      // 400/401 here means bad tenant/client/secret: a configuration problem, not transient.
      const retryable = res.status >= 500 || res.status === 429;
      throw new IntegrationError(`Failed to acquire Microsoft Graph token (HTTP ${res.status})`, { retryable, status: res.status });
    }
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: body.access_token, expiresAt: this.now() + body.expires_in * 1000 };
    return this.token.value;
  }

  /** Performs a Graph request. `path` is relative to the v1.0 base or an absolute nextLink. */
  async request(method: string, path: string, init: { body?: RequestInit["body"]; headers?: Record<string, string> } = {}): Promise<Response> {
    let refreshedAfter401 = false;
    for (let attempt = 1; ; attempt++) {
      const token = await this.accessToken();
      let res: Response;
      try {
        res = await this.fetchFn(path.startsWith("https://") ? path : `${this.baseUrl}${path}`, {
          method,
          body: init.body,
          headers: { ...init.headers, authorization: `Bearer ${token}` },
        });
      } catch {
        if (attempt < this.maxAttempts) {
          await this.sleep(this.backoff(attempt));
          continue;
        }
        throw new IntegrationError(`Microsoft Graph unreachable (${method} ${redactPath(path)})`, { retryable: true });
      }
      if (res.ok) return res;

      const code = await graphErrorCode(res);
      const where = `${method} ${redactPath(path)}`;
      if (res.status === 401 && !refreshedAfter401) {
        refreshedAfter401 = true;
        this.token = null; // expired or revoked token: refresh once
        continue;
      }
      if (res.status === 429 || res.status === 503 || res.status === 504) {
        const retryAfterMs = parseRetryAfter(res.headers.get("retry-after")) ?? this.backoff(attempt);
        if (attempt < this.maxAttempts && retryAfterMs <= this.maxInlineWaitMs) {
          await this.sleep(retryAfterMs);
          continue;
        }
        throw new IntegrationError(`Microsoft Graph throttled or unavailable (HTTP ${res.status}, ${where})`, { retryable: true, status: res.status, retryAfterMs });
      }
      if (res.status >= 500) {
        if (attempt < this.maxAttempts) {
          await this.sleep(this.backoff(attempt));
          continue;
        }
        throw new IntegrationError(`Microsoft Graph server error (HTTP ${res.status}, ${where})`, { retryable: true, status: res.status });
      }
      if (res.status === 401 || res.status === 403) {
        throw new IntegrationError(`Microsoft Graph permission denied (HTTP ${res.status}${code ? `, ${code}` : ""}, ${where}). Check the app's Sites.Selected grant.`, { retryable: false, status: res.status });
      }
      throw new IntegrationError(`Microsoft Graph request failed (HTTP ${res.status}${code ? `, ${code}` : ""}, ${where})`, { retryable: false, status: res.status });
    }
  }

  async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.request(method, path, body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    return (await res.json()) as T;
  }

  private backoff(attempt: number) {
    return Math.min(500 * 2 ** (attempt - 1), 8000);
  }
}

async function graphErrorCode(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { error?: { code?: string } };
    return body.error?.code;
  } catch {
    return undefined;
  }
}

export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** Error messages keep the endpoint shape but drop file names and query strings. */
function redactPath(path: string) {
  return path.replace(/^https:\/\/[^/]+\/v1\.0/, "").replace(/root:\/[^:]*:/, "root:/…:").replace(/\?.*$/, "");
}
