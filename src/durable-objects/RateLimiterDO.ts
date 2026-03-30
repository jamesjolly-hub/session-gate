/**
 * RateLimiterDO — Per-key sliding-window rate limiter backed by DO SQLite.
 *
 * One DO instance per rate-limit key (e.g., userId or IP address).
 * Sliding window: each request is recorded with a timestamp; the window
 * is checked by counting rows within the last N milliseconds.
 *
 * Alarm-driven cleanup: an alarm fires periodically to purge old request
 * rows and prevent unbounded storage growth.
 */

import type { DurableObject } from "cloudflare:workers";

export class RateLimiterDO implements DurableObject {
  private readonly sql: SqlStorage;
  private readonly maxRequests: number;
  private readonly windowMs: number;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Record<string, string>
  ) {
    this.sql = ctx.storage.sql;
    this.maxRequests = parseInt(env["RATE_LIMIT_MAX"] ?? "100", 10);
    this.windowMs = parseInt(env["RATE_LIMIT_WINDOW_MS"] ?? "60000", 10);
    // blockConcurrencyWhile ensures schema init completes before fetch/alarm
    ctx.blockConcurrencyWhile(() => Promise.resolve(this.initSchema()));
  }

  private initSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS requests (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        request_at INTEGER NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_requests_at ON requests (request_at DESC)
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/check") {
      return await this.handleCheck(this.maxRequests, this.windowMs);
    }

    // POST /check-custom?limit=N&windowMs=M — used by /rate-check worker route
    if (request.method === "POST" && url.pathname === "/check-custom") {
      const limit = parseInt(url.searchParams.get("limit") ?? String(this.maxRequests), 10);
      const windowMs = parseInt(url.searchParams.get("windowMs") ?? String(this.windowMs), 10);
      return await this.handleCheck(limit, windowMs);
    }

    if (request.method === "DELETE" && url.pathname === "/reset") {
      return this.handleReset();
    }

    if (request.method === "GET" && url.pathname === "/status") {
      return this.handleStatus();
    }

    return new Response("Not found", { status: 404 });
  }

  private async handleCheck(maxRequests: number, windowMs: number): Promise<Response> {
    const now = Date.now();
    const windowStart = now - windowMs;

    // Purge requests outside the current window
    this.sql.exec(`DELETE FROM requests WHERE request_at < ?`, windowStart);

    // Count requests in current window and find oldest to compute resets_at
    const countRow = this.sql
      .exec<{ cnt: number; oldest_at: number | null }>(
        `SELECT COUNT(*) AS cnt, MIN(request_at) AS oldest_at FROM requests WHERE request_at >= ?`,
        windowStart
      )
      .toArray();
    const currentCount = countRow[0]?.cnt ?? 0;
    const oldestAt = countRow[0]?.oldest_at ?? null;
    // resets_at: earliest time all current-window requests will have expired
    const resetsAt = oldestAt != null
      ? new Date(oldestAt + windowMs).toISOString()
      : new Date(now + windowMs).toISOString();

    if (currentCount >= maxRequests) {
      return Response.json(
        {
          allowed: false,
          remaining: 0,
          resets_at: resetsAt,
          // legacy fields preserved for backward compat
          currentCount,
          limit: maxRequests,
          windowMs,
          retryAfterMs: windowMs,
        },
        { status: 429 }
      );
    }

    // Record this request
    this.sql.exec(`INSERT INTO requests (request_at) VALUES (?)`, now);

    // Schedule cleanup alarm only if one isn't already pending
    const existingAlarm = await this.ctx.storage.getAlarm();
    if (!existingAlarm) {
      await this.ctx.storage.setAlarm(now + windowMs);
    }

    return Response.json({
      allowed: true,
      remaining: maxRequests - currentCount - 1,
      resets_at: resetsAt,
      // legacy fields preserved for backward compat
      currentCount: currentCount + 1,
      limit: maxRequests,
      windowMs,
      remainingRequests: maxRequests - currentCount - 1,
    });
  }

  private handleReset(): Response {
    this.sql.exec(`DELETE FROM requests`);
    return Response.json({ reset: true });
  }

  private handleStatus(): Response {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    const row = this.sql
      .exec<{ cnt: number }>(`SELECT COUNT(*) AS cnt FROM requests WHERE request_at >= ?`, windowStart)
      .toArray();
    return Response.json({
      currentCount: row[0]?.cnt ?? 0,
      limit: this.maxRequests,
      windowMs: this.windowMs,
    });
  }

  /** Alarm: purge old rows to keep the table lean */
  async alarm(): Promise<void> {
    const cutoff = Date.now() - this.windowMs;
    this.sql.exec(`DELETE FROM requests WHERE request_at < ?`, cutoff);
  }
}
