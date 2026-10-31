import type { Clock } from "./util.ts";
import { tooManyRequests } from "./errors.ts";

/** Fixed-window limiter, per key. In-process only: each server instance enforces its own budget. */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly clock: Clock;
  constructor(limit: number, windowMs: number, clock: Clock) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.clock = clock;
  }

  consume(key: string): void {
    const now = this.clock.now().getTime();
    const w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      this.windows.set(key, { start: now, count: 1 });
      return;
    }
    if (w.count >= this.limit) throw tooManyRequests(Math.ceil((w.start + this.windowMs - now) / 1000));
    w.count++;
  }
}
