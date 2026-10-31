import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3001),
  HOST: z.string().default("127.0.0.1"),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:5173"),
  DATABASE_PATH: z.string().default("./data/kta.db"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  WEB_DIST_DIR: z.string().optional(),

  AUTH_MODE: z.enum(["demo", "entra"]).default("demo"),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(10),
  ENTRA_TENANT_ID: z.string().optional(),
  ENTRA_CLIENT_ID: z.string().optional(),
  ENTRA_CLIENT_SECRET: z.string().optional(),
  ENTRA_REDIRECT_URI: z.string().url().optional(),
  ENTRA_AUTO_PROVISION: bool.default(false),

  SHAREPOINT_MODE: z.enum(["mock", "graph"]).default("mock"),
  GRAPH_TENANT_ID: z.string().optional(),
  GRAPH_CLIENT_ID: z.string().optional(),
  GRAPH_CLIENT_SECRET: z.string().optional(),
  SHAREPOINT_SITE_ID: z.string().optional(),
  SHAREPOINT_DRIVE_ID: z.string().optional(),
  SHAREPOINT_ROOT_FOLDER: z.string().default("KnowledgeTransfer"),
  SHAREPOINT_SET_METADATA: bool.default(true),

  LLM_PROVIDER: z.enum(["extractive", "anthropic"]).default("extractive"),
  ANTHROPIC_MODEL: z.string().default("claude-opus-5-5"),
  ANTHROPIC_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),

  JOB_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  ASSISTANT_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(20),
  DOCUMENT_STALE_AFTER_DAYS: z.coerce.number().int().positive().default(365),
});

export type Config = z.infer<typeof EnvSchema>;

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ConfigError(`Invalid configuration: ${issues}`);
  }
  const cfg = parsed.data;
  assertConsistent(cfg);
  return cfg;
}

function requireKeys(cfg: Config, keys: (keyof Config)[], reason: string) {
  const missing = keys.filter((k) => !cfg[k]);
  if (missing.length) throw new ConfigError(`${reason} requires: ${missing.join(", ")}`);
}

function assertConsistent(cfg: Config) {
  if (cfg.NODE_ENV === "production") {
    // Simulated substitutes must never run silently in production.
    if (cfg.AUTH_MODE === "demo") throw new ConfigError("AUTH_MODE=demo is not allowed when NODE_ENV=production");
    if (cfg.SHAREPOINT_MODE === "mock") throw new ConfigError("SHAREPOINT_MODE=mock is not allowed when NODE_ENV=production");
  }
  if (cfg.AUTH_MODE === "entra") {
    requireKeys(cfg, ["ENTRA_TENANT_ID", "ENTRA_CLIENT_ID", "ENTRA_CLIENT_SECRET", "ENTRA_REDIRECT_URI"], "AUTH_MODE=entra");
  }
  if (cfg.SHAREPOINT_MODE === "graph") {
    requireKeys(
      cfg,
      ["GRAPH_TENANT_ID", "GRAPH_CLIENT_ID", "GRAPH_CLIENT_SECRET", "SHAREPOINT_SITE_ID", "SHAREPOINT_DRIVE_ID"],
      "SHAREPOINT_MODE=graph",
    );
  }
}

/** Configuration for tests: in-memory DB, demo/mock/extractive, quiet logs. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return { ...loadConfig({ NODE_ENV: "test", DATABASE_PATH: ":memory:", LOG_LEVEL: "silent" }), ...overrides };
}
