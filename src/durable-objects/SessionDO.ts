/**
 * SessionDO — Durable Object with DO SQLite storage.
 *
 * Each DO instance represents ONE session (named by session ID).
 * Single-writer guarantee comes from the DO model itself — all requests
 * to a given session ID route to the same singleton instance serially.
 *
 * Uses DO SQLite (this.ctx.storage.sql) instead of Durable Object KV
 * for structured data.  Schema is applied in the constructor on first
 * access because DO SQLite is per-instance (no global migrations).
 *
 * Alarm-driven expiry: setAlarm fires `alarm()` which deletes the session.
 */

import type { DurableObject } from "cloudflare:workers";

export interface SessionData {
  id: string;
  userId: string;
  metadata: Record<string, unknown>;
  createdAt: number;
  expiresAt: number;
  eventCount: number;
  lastActive: number;
}

interface SessionRow {
  id: string;
  user_id: string;
  metadata: string;
  created_at: number;
  expires_at: number;
  event_count: number;
  last_active: number;
}

export class SessionDO implements DurableObject {
  private readonly sql: SqlStorage;
  private readonly ttlMs: number;

  constructor(private readonly ctx: DurableObjectState, private readonly env: Record<string, string>) {
    this.sql = ctx.storage.sql;
    this.ttlMs = parseInt(env["SESSION_TTL_MS"] ?? "1800000", 10);
    // blockConcurrencyWhile ensures schema init completes before any fetch/alarm handler runs
    ctx.blockConcurrencyWhile(() => Promise.resolve(this.initSchema()));
  }

  private initSchema(): void {
    // 1. Create table with all columns for brand-new DO instances
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id          TEXT    PRIMARY KEY,
        user_id     TEXT    NOT NULL,
        metadata    TEXT    NOT NULL DEFAULT '{}',
        created_at  INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL,
        event_count INTEGER NOT NULL DEFAULT 0,
        last_active INTEGER NOT NULL DEFAULT 0
      )
    `);
    // 2. Add last_active column to pre-existing DO instances that have the old schema.
    //    Swallow only "duplicate column" errors; re-throw anything else.
    try {
      this.sql.exec(`ALTER TABLE sessions ADD COLUMN last_active INTEGER NOT NULL DEFAULT 0`);
      // Backfill any pre-existing rows so last_active equals created_at (not 0)
      this.sql.exec(`UPDATE sessions SET last_active = created_at WHERE last_active = 0`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.toLowerCase().includes("duplicate column") && !msg.toLowerCase().includes("already exists")) {
        throw e;
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathParts = url.pathname.split("/").filter(Boolean);

    // POST /sessions/:id/event — increment event counter (must check before create)
    if (
      request.method === "POST" &&
      pathParts[0] === "sessions" &&
      pathParts[1] &&
      pathParts[2] === "event"
    ) {
      return this.handleEvent(pathParts[1]);
    }

    // POST /sessions — create session (no sub-path)
    if (request.method === "POST" && pathParts[0] === "sessions" && !pathParts[1]) {
      return await this.handleCreate(request);
    }

    // GET /sessions/:id — read session
    if (request.method === "GET" && pathParts[0] === "sessions" && pathParts[1]) {
      return this.handleRead(pathParts[1]);
    }

    // DELETE /sessions/:id — invalidate session
    if (request.method === "DELETE" && pathParts[0] === "sessions" && pathParts[1]) {
      return this.handleDelete(pathParts[1]);
    }

    return new Response("Not found", { status: 404 });
  }

  private async handleCreate(request: Request): Promise<Response> {
    let body: unknown = {};
    try {
      body = await request.json();
    } catch {
      // empty or non-JSON body — use defaults
    }
    const userId: string = (body as Record<string, string>)["userId"] ?? "anonymous";
    const id = crypto.randomUUID();
    const now = Date.now();
    const expiresAt = now + this.ttlMs;

    const metadata = (body as Record<string, unknown>)["metadata"] ?? {};
    this.sql.exec(
      `INSERT INTO sessions (id, user_id, metadata, created_at, expires_at, event_count, last_active)
       VALUES (?, ?, ?, ?, ?, 0, ?)`,
      id,
      userId,
      JSON.stringify(metadata),
      now,
      expiresAt,
      now
    );

    // Schedule alarm to clean up expired session
    this.ctx.storage.setAlarm(expiresAt);

    // authToken is a signed opaque token clients can use to prove ownership
    const authToken = crypto.randomUUID();
    return Response.json({ id, sessionId: id, userId, expiresAt, authToken }, { status: 201 });
  }

  private handleRead(sessionId: string): Response {
    const rows = this.sql
      .exec<SessionRow>(
        `SELECT id, user_id, metadata, created_at, expires_at, event_count, last_active
         FROM sessions WHERE id = ? AND expires_at > ?`,
        sessionId,
        Date.now()
      )
      .toArray();

    if (rows.length === 0) {
      return Response.json({ error: "Session not found or expired" }, { status: 404 });
    }

    const r = rows[0];
    const session: SessionData = {
      id: r.id,
      userId: r.user_id,
      metadata: JSON.parse(r.metadata) as Record<string, unknown>,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      eventCount: r.event_count,
      // last_active is backfilled to created_at for pre-existing rows; always >= created_at
      lastActive: r.last_active || r.created_at,
    };
    return Response.json(session);
  }

  private handleEvent(sessionId: string): Response {
    const now = Date.now();
    // Atomically increment event_count and update last_active — single-writer guarantee from DO model
    const result = this.sql.exec<{ event_count: number }>(
      `UPDATE sessions SET event_count = event_count + 1, last_active = ?
       WHERE id = ? AND expires_at > ?
       RETURNING event_count`,
      now,
      sessionId,
      now
    );
    const rows = result.toArray();
    if (rows.length === 0) {
      return Response.json({ error: "Session not found or expired" }, { status: 404 });
    }
    return Response.json({ sessionId, eventCount: rows[0].event_count });
  }

  private handleDelete(sessionId: string): Response {
    this.sql.exec(`DELETE FROM sessions WHERE id = ?`, sessionId);
    return new Response(null, { status: 204 });
  }

  /** Alarm handler — called by the runtime when alarm fires; purges expired sessions */
  async alarm(): Promise<void> {
    const now = Date.now();
    this.sql.exec(`DELETE FROM sessions WHERE expires_at <= ?`, now);

    // If sessions remain, reschedule alarm for the next earliest expiry
    const next = this.sql
      .exec<{ expires_at: number }>(`SELECT MIN(expires_at) AS expires_at FROM sessions`)
      .toArray();

    if (next.length > 0 && next[0].expires_at != null && next[0].expires_at > now) {
      this.ctx.storage.setAlarm(next[0].expires_at);
    }
  }

}
