import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.ts";
import { testConfig, type Config } from "../src/config.ts";
import type { Clock } from "../src/lib/util.ts";
import { seedSynthetic, PEOPLE, type PersonKey, type SeedResult } from "../src/seed/synthetic.ts";
import { buildServices, type Overrides, type Services } from "../src/services.ts";

export class TestClock implements Clock {
  t: number;
  constructor(iso = "2026-11-02T09:00:00.000Z") {
    this.t = Date.parse(iso);
  }
  now() {
    return new Date(this.t);
  }
  advance(ms: number) {
    this.t += ms;
  }
}

export const silentLogger = { info() {}, warn() {}, error() {} };

export interface TestEnv {
  s: Services;
  app: FastifyInstance;
  clock: TestClock;
  seed: SeedResult;
  login(who: PersonKey): Promise<Client>;
}

export async function setup(opts: { cfg?: Partial<Config>; overrides?: Overrides; seed?: boolean } = {}): Promise<TestEnv> {
  const clock = new TestClock();
  const s = buildServices(testConfig(opts.cfg), { clock, logger: silentLogger, ...opts.overrides });
  const app = await buildApp(s);
  const seed = opts.seed === false ? ({} as SeedResult) : await seedSynthetic(s);
  return { s, app, clock, seed, login: (who) => Client.login(app, PEOPLE[who].email) };
}

/** Minimal HTTP client over fastify.inject that carries the session cookie and CSRF token. */
export class Client {
  private readonly app: FastifyInstance;
  cookie = "";
  csrf = "";
  constructor(app: FastifyInstance) {
    this.app = app;
  }

  static async login(app: FastifyInstance, email: string) {
    const c = new Client(app);
    const res = await app.inject({ method: "POST", url: "/api/auth/demo-login", payload: { email } });
    if (res.statusCode !== 200) throw new Error(`login failed for ${email}: ${res.body}`);
    c.cookie = String(res.headers["set-cookie"]).split(";")[0]!;
    c.csrf = res.json().csrfToken;
    return c;
  }

  async req(method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown, opts: { csrf?: boolean } = {}) {
    const headers: Record<string, string> = { cookie: this.cookie };
    if (opts.csrf !== false && method !== "GET") headers["x-csrf-token"] = this.csrf;
    const res = await this.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
    let body: any = null;
    try {
      body = res.json();
    } catch {
      body = res.body;
    }
    return { status: res.statusCode, body, raw: res.body };
  }
  get(url: string) {
    return this.req("GET", url);
  }
  post(url: string, payload: unknown = {}) {
    return this.req("POST", url, payload);
  }
  put(url: string, payload: unknown) {
    return this.req("PUT", url, payload);
  }
}
