import pino from "pino";
import type { Config } from "./config.ts";
import { migrate, openDatabase, type Db } from "./db/database.ts";
import { RateLimiter } from "./lib/rate-limit.ts";
import { systemClock, type Clock } from "./lib/util.ts";
import { AnthropicProvider } from "./modules/assistant/anthropic-provider.ts";
import { AssistantService } from "./modules/assistant/assistant-service.ts";
import { ExtractiveProvider } from "./modules/assistant/extractive-provider.ts";
import type { LlmProvider } from "./modules/assistant/provider.ts";
import { AuditLog } from "./modules/audit/audit.ts";
import { HandoverService, PUBLISH_JOB } from "./modules/handover/handover-service.ts";
import { createPublishHandler, INGEST_JOB } from "./modules/handover/publication.ts";
import { EntraOidc } from "./modules/identity/entra.ts";
import { SessionStore } from "./modules/identity/sessions.ts";
import { UserRepository } from "./modules/identity/users.ts";
import { JobQueue, type Logger } from "./modules/jobs/queue.ts";
import { ProjectService } from "./modules/projects/projects.ts";
import { IndexService } from "./modules/retrieval/index-service.ts";
import { GraphDocumentRepository } from "./modules/sharepoint/graph-adapter.ts";
import { GraphClient } from "./modules/sharepoint/graph-client.ts";
import { MockDocumentRepository } from "./modules/sharepoint/mock-adapter.ts";
import type { DocumentRepository } from "./modules/sharepoint/types.ts";

export interface Overrides {
  db?: Db;
  clock?: Clock;
  repo?: DocumentRepository;
  provider?: LlmProvider;
  logger?: Logger;
  /** Destination for structured logs (defaults to stdout). Used by tests to inspect log output. */
  logStream?: NodeJS.WritableStream;
}

export const REDACT_PATHS = [
  "req.headers.cookie",
  "req.headers.authorization",
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  "*.access_token",
  "*.id_token",
  "*.client_secret",
  "*.password",
];

/** Composition root: wires every module from configuration. Integrations are injectable for tests. */
export function buildServices(cfg: Config, o: Overrides = {}) {
  const pinoLogger = pino({ level: cfg.LOG_LEVEL, redact: REDACT_PATHS }, (o.logStream ?? process.stdout) as pino.DestinationStream);
  const logger: Logger = o.logger ?? pinoLogger;
  const clock = o.clock ?? systemClock;
  const db = o.db ?? openDatabase(cfg.DATABASE_PATH);
  migrate(db);

  const audit = new AuditLog(db, clock);
  const users = new UserRepository(db, clock);
  const sessions = new SessionStore(db, users, clock, cfg.SESSION_TTL_HOURS);
  const entra = cfg.AUTH_MODE === "entra" ? new EntraOidc(cfg, db, clock) : null;
  const projects = new ProjectService(db, clock, audit);
  const jobs = new JobQueue(db, clock, logger);

  const repo: DocumentRepository =
    o.repo ??
    (cfg.SHAREPOINT_MODE === "graph"
      ? new GraphDocumentRepository(
          new GraphClient({ tenantId: cfg.GRAPH_TENANT_ID!, clientId: cfg.GRAPH_CLIENT_ID!, clientSecret: cfg.GRAPH_CLIENT_SECRET! }),
          { siteId: cfg.SHAREPOINT_SITE_ID!, driveId: cfg.SHAREPOINT_DRIVE_ID!, rootFolder: cfg.SHAREPOINT_ROOT_FOLDER, setMetadata: cfg.SHAREPOINT_SET_METADATA },
        )
      : new MockDocumentRepository(db, clock, cfg.SHAREPOINT_ROOT_FOLDER));

  const provider: LlmProvider =
    o.provider ?? (cfg.LLM_PROVIDER === "anthropic" ? new AnthropicProvider({ model: cfg.ANTHROPIC_MODEL, effort: cfg.ANTHROPIC_EFFORT }) : new ExtractiveProvider());

  const index = new IndexService(db, repo, clock, cfg.DOCUMENT_STALE_AFTER_DAYS);
  const handovers = new HandoverService({ db, clock, projects, users, jobs, audit, adapterMode: repo.mode });
  const assistant = new AssistantService({
    db,
    clock,
    projects,
    index,
    provider,
    audit,
    limiter: new RateLimiter(cfg.ASSISTANT_RATE_LIMIT_PER_MINUTE, 60_000, clock),
  });

  jobs.register(PUBLISH_JOB, createPublishHandler({ db, repo, jobs, clock, audit }));
  jobs.register(INGEST_JOB, async (job) => {
    const { projectId } = job.payload as { projectId: string };
    const report = await index.ingestProject(projectId);
    audit.record({ actorId: null, action: "retrieval.ingest", entityType: "project", entityId: projectId, projectId, details: { ...report } });
  });

  return { cfg, logger, pinoLogger, clock, db, audit, users, sessions, entra, projects, jobs, repo, provider, index, handovers, assistant, loginLimiter: new RateLimiter(10, 60_000, clock) };
}

export type Services = ReturnType<typeof buildServices>;
