import type { Db } from "../../db/database.ts";
import { PermanentError } from "../../lib/errors.ts";
import { addMs, iso, newId, type Clock } from "../../lib/util.ts";

export interface Job {
  id: string;
  type: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
}

export type JobHandler = (job: Job) => Promise<void>;

export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

const LEASE_MS = 5 * 60_000;

/** Errors may carry a server-requested delay (e.g. Graph `Retry-After`). */
export interface RetryAfter {
  retryAfterMs?: number;
}

/**
 * Durable job queue on the application database. Jobs survive restarts; a crashed worker's
 * lease expires and the job is picked up again. `dedupeKey` prevents duplicate queued work.
 */
export class JobQueue {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly handlers = new Map<string, JobHandler>();
  private readonly log: Logger;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(db: Db, clock: Clock, log: Logger) {
    this.db = db;
    this.clock = clock;
    this.log = log;
  }

  register(type: string, handler: JobHandler) {
    this.handlers.set(type, handler);
  }

  /** Returns the job id, or null if an identical job (same dedupeKey) is already queued. */
  enqueue(type: string, payload: unknown, opts: { dedupeKey?: string; runAt?: Date; maxAttempts?: number } = {}): string | null {
    const now = iso(this.clock.now());
    const id = newId();
    const res = this.db
      .prepare(
        `INSERT INTO jobs (id, type, payload_json, status, max_attempts, run_at, dedupe_key, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .run(id, type, JSON.stringify(payload), opts.maxAttempts ?? 6, iso(opts.runAt ?? this.clock.now()), opts.dedupeKey ?? null, now, now);
    return res.changes > 0 ? id : null;
  }

  private claim(): (Job & { row: true }) | null {
    const now = this.clock.now();
    const row = this.db
      .prepare(
        `UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_until = ?, updated_at = ?
         WHERE id = (
           SELECT id FROM jobs
           WHERE (status = 'pending' AND run_at <= ?) OR (status = 'running' AND locked_until <= ?)
           ORDER BY run_at LIMIT 1)
         RETURNING *`,
      )
      .get(iso(addMs(now, LEASE_MS)), iso(now), iso(now), iso(now));
    if (!row) return null;
    return {
      row: true,
      id: String(row.id),
      type: String(row.type),
      payload: JSON.parse(String(row.payload_json)),
      attempts: Number(row.attempts),
      maxAttempts: Number(row.max_attempts),
    };
  }

  /** Processes all jobs that are due now. Returns the number processed. */
  async runDue(limit = 100): Promise<number> {
    let n = 0;
    for (; n < limit; n++) {
      const job = this.claim();
      if (!job) break;
      await this.execute(job);
    }
    return n;
  }

  private async execute(job: Job) {
    const handler = this.handlers.get(job.type);
    const now = this.clock.now();
    try {
      if (!handler) throw new PermanentError(`No handler registered for job type ${job.type}`);
      await handler(job);
      this.db.prepare("UPDATE jobs SET status = 'succeeded', locked_until = NULL, last_error = NULL, updated_at = ? WHERE id = ?").run(iso(this.clock.now()), job.id);
    } catch (err) {
      const message = err instanceof Error ? err.message.slice(0, 1000) : "unknown error";
      const permanent = err instanceof PermanentError || job.attempts >= job.maxAttempts;
      if (permanent) {
        this.db.prepare("UPDATE jobs SET status = 'dead', locked_until = NULL, last_error = ?, updated_at = ? WHERE id = ?").run(message, iso(now), job.id);
        this.log.error({ jobId: job.id, type: job.type, attempts: job.attempts }, `job failed permanently: ${message}`);
      } else {
        const requested = (err as RetryAfter).retryAfterMs;
        const backoff = requested ?? Math.min(30_000 * 2 ** (job.attempts - 1), 60 * 60_000);
        this.db
          .prepare("UPDATE jobs SET status = 'pending', locked_until = NULL, last_error = ?, run_at = ?, updated_at = ? WHERE id = ?")
          .run(message, iso(addMs(now, backoff)), iso(now), job.id);
        this.log.warn({ jobId: job.id, type: job.type, attempts: job.attempts, retryInMs: backoff }, `job failed, will retry: ${message}`);
      }
    }
  }

  start(intervalMs: number) {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.runDue()
        .catch((err) => this.log.error({ err: String(err) }, "job runner error"))
        .finally(() => (this.running = false));
    }, intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  stats() {
    return this.db.prepare("SELECT type, status, COUNT(*) AS n FROM jobs GROUP BY type, status").all() as { type: string; status: string; n: number }[];
  }

  recentFailures(limit = 20) {
    return this.db
      .prepare("SELECT id, type, status, attempts, last_error, updated_at FROM jobs WHERE last_error IS NOT NULL ORDER BY updated_at DESC LIMIT ?")
      .all(limit);
  }
}
