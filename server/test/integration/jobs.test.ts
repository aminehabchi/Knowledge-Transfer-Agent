import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { migrate, openDatabase } from "../../src/db/database.ts";
import { PermanentError } from "../../src/lib/errors.ts";
import { JobQueue } from "../../src/modules/jobs/queue.ts";
import { silentLogger, TestClock } from "../helpers.ts";

function queue(path = ":memory:", clock = new TestClock()) {
  const db = openDatabase(path);
  migrate(db);
  return { db, clock, q: new JobQueue(db, clock, silentLogger) };
}

const status = (db: ReturnType<typeof openDatabase>, id: string) => db.prepare("SELECT status, attempts, last_error FROM jobs WHERE id = ?").get(id)!;

describe("persistent job queue", () => {
  it("runs due jobs and marks them succeeded", async () => {
    const { db, q } = queue();
    const seen: unknown[] = [];
    q.register("t", async (j) => void seen.push(j.payload));
    const id = q.enqueue("t", { a: 1 })!;
    assert.equal(await q.runDue(), 1);
    assert.deepEqual(seen, [{ a: 1 }]);
    assert.equal(status(db, id).status, "succeeded");
  });

  it("does not run jobs scheduled in the future", async () => {
    const { q, clock } = queue();
    q.register("t", async () => {});
    q.enqueue("t", {}, { runAt: new Date(clock.t + 60_000) });
    assert.equal(await q.runDue(), 0);
    clock.advance(60_000);
    assert.equal(await q.runDue(), 1);
  });

  it("deduplicates queued jobs with the same key", () => {
    const { q } = queue();
    assert.ok(q.enqueue("t", {}, { dedupeKey: "k" }));
    assert.equal(q.enqueue("t", {}, { dedupeKey: "k" }), null);
  });

  it("allows the same dedupe key again once the earlier job finished", async () => {
    const { q } = queue();
    q.register("t", async () => {});
    q.enqueue("t", {}, { dedupeKey: "k" });
    await q.runDue();
    assert.ok(q.enqueue("t", {}, { dedupeKey: "k" }));
  });

  it("retries failures with exponential backoff, then marks the job dead", async () => {
    const { db, q, clock } = queue();
    q.register("t", async () => {
      throw new Error("boom");
    });
    const id = q.enqueue("t", {}, { maxAttempts: 3 })!;
    await q.runDue();
    assert.equal(status(db, id).status, "pending");
    assert.equal(await q.runDue(), 0, "backoff delays the retry");
    clock.advance(30_000);
    await q.runDue();
    clock.advance(60_000);
    await q.runDue();
    const s = status(db, id);
    assert.equal(s.status, "dead");
    assert.equal(s.attempts, 3);
    assert.equal(s.last_error, "boom");
  });

  it("does not retry permanent errors", async () => {
    const { db, q } = queue();
    q.register("t", async () => {
      throw new PermanentError("bad config");
    });
    const id = q.enqueue("t", {})!;
    await q.runDue();
    assert.equal(status(db, id).status, "dead");
  });

  it("honours a Retry-After delay requested by an integration", async () => {
    const { db, q, clock } = queue();
    q.register("t", async () => {
      throw Object.assign(new Error("throttled"), { retryAfterMs: 120_000 });
    });
    const id = q.enqueue("t", {})!;
    await q.runDue();
    const runAt = Date.parse(String(db.prepare("SELECT run_at FROM jobs WHERE id = ?").get(id)!.run_at));
    assert.equal(runAt - clock.t, 120_000);
  });

  it("survives a restart: a job claimed by a crashed worker is recovered after its lease expires", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kta-jobs-"));
    try {
      const path = join(dir, "jobs.db");
      const clock = new TestClock();
      const first = queue(path, clock);
      const id = first.q.enqueue("t", { n: 1 })!;
      // Simulate a crash mid-job: claim it, then drop the process without finishing.
      first.db.prepare("UPDATE jobs SET status = 'running', attempts = 1, locked_until = ? WHERE id = ?").run(new Date(clock.t + 300_000).toISOString(), id);
      first.db.close();

      const second = queue(path, clock);
      let ran = 0;
      second.q.register("t", async () => void ran++);
      assert.equal(await second.q.runDue(), 0, "lease still held");
      clock.advance(300_001);
      assert.equal(await second.q.runDue(), 1);
      assert.equal(ran, 1);
      assert.equal(status(second.db, id).status, "succeeded");
      second.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
