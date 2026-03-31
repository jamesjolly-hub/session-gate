/**
 * session-gate tests
 *
 * Tests SessionDO and RateLimiterDO behaviour through the Worker router,
 * including the /session/create spec alias.
 * SELF.fetch() routes through the full Worker → DO chain.
 */

import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

const BASE = "http://session-gate.workers.dev";

// ---------------------------------------------------------------------------
// Session CRUD (canonical /sessions routes)
// ---------------------------------------------------------------------------

describe("Session CRUD", () => {
  it("creates a session and returns an id", async () => {
    const res = await SELF.fetch(`${BASE}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-001" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; userId: string; expiresAt: number };
    expect(typeof body.id).toBe("string");
    expect(body.userId).toBe("user-001");
    expect(body.expiresAt).toBeGreaterThan(Date.now());
  });

  it("reads an existing session by id", async () => {
    // Create first
    const createRes = await SELF.fetch(`${BASE}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-read-test" }),
    });
    const created = (await createRes.json()) as { id: string };

    const readRes = await SELF.fetch(`${BASE}/sessions/${created.id}`);
    expect(readRes.status).toBe(200);
    const body = (await readRes.json()) as { id: string; userId: string; eventCount: number };
    expect(body.id).toBe(created.id);
    expect(body.userId).toBe("user-read-test");
    expect(body.eventCount).toBe(0);
  });

  it("returns 404 for a non-existent session", async () => {
    const res = await SELF.fetch(`${BASE}/sessions/does-not-exist-00000`);
    expect(res.status).toBe(404);
  });

  it("deletes a session and returns 404 afterward", async () => {
    const createRes = await SELF.fetch(`${BASE}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-delete-test" }),
    });
    const created = (await createRes.json()) as { id: string };

    const delRes = await SELF.fetch(`${BASE}/sessions/${created.id}`, { method: "DELETE" });
    expect(delRes.status).toBe(204);

    const readRes = await SELF.fetch(`${BASE}/sessions/${created.id}`);
    expect(readRes.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Spec alias: POST /session/create → same as POST /sessions
// ---------------------------------------------------------------------------

describe("POST /session/create (spec alias for POST /sessions)", () => {
  it("creates a session and returns 201 — same status as /sessions", async () => {
    const res = await SELF.fetch(`${BASE}/session/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-alias-test" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; userId: string; expiresAt: number };
    expect(typeof body.id).toBe("string");
    expect(body.userId).toBe("user-alias-test");
    expect(body.expiresAt).toBeGreaterThan(Date.now());
  });

  it("created session via alias is readable via canonical GET /sessions/:id", async () => {
    const createRes = await SELF.fetch(`${BASE}/session/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-alias-readable" }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: string };

    const readRes = await SELF.fetch(`${BASE}/sessions/${created.id}`);
    expect(readRes.status).toBe(200);
    const session = (await readRes.json()) as { id: string; userId: string };
    expect(session.id).toBe(created.id);
    expect(session.userId).toBe("user-alias-readable");
  });
});

// ---------------------------------------------------------------------------
// last_active — spec field: GET /sessions/:id returns last_active timestamp
// ---------------------------------------------------------------------------

describe("last_active field on session state", () => {
  it("returns lastActive equal to createdAt on a fresh session (no events)", async () => {
    const before = Date.now();
    const createRes = await SELF.fetch(`${BASE}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-last-active-fresh" }),
    });
    expect(createRes.status).toBe(201);
    const { id } = (await createRes.json()) as { id: string };

    const readRes = await SELF.fetch(`${BASE}/sessions/${id}`);
    expect(readRes.status).toBe(200);
    const session = (await readRes.json()) as { lastActive: number; createdAt: number };
    expect(typeof session.lastActive).toBe("number");
    expect(session.lastActive).toBeGreaterThanOrEqual(before);
    expect(session.lastActive).toBeGreaterThan(0);
    // On a fresh session, lastActive should equal createdAt
    expect(session.lastActive).toBe(session.createdAt);
  });

  it("updates lastActive when an event is recorded", async () => {
    const createRes = await SELF.fetch(`${BASE}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-last-active-update" }),
    });
    const { id } = (await createRes.json()) as { id: string };

    // Read before event
    const beforeRes = await SELF.fetch(`${BASE}/sessions/${id}`);
    const before = (await beforeRes.json()) as { lastActive: number };

    // Fire an event
    await SELF.fetch(`${BASE}/sessions/${id}/event`, { method: "POST" });

    // Read after event
    const afterRes = await SELF.fetch(`${BASE}/sessions/${id}`);
    const after = (await afterRes.json()) as { lastActive: number; eventCount: number };
    expect(after.lastActive).toBeGreaterThanOrEqual(before.lastActive);
    expect(after.lastActive).toBeGreaterThan(0);
    expect(after.eventCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Single-writer concurrency: 20 sequential + 100 concurrent events
// ---------------------------------------------------------------------------

describe("Single-writer event counter", () => {
  it("serially increments event_count to exactly N", async () => {
    const createRes = await SELF.fetch(`${BASE}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-counter" }),
    });
    const { id } = (await createRes.json()) as { id: string };

    const N = 20;
    for (let i = 0; i < N; i++) {
      const res = await SELF.fetch(`${BASE}/sessions/${id}/event`, { method: "POST" });
      expect(res.status).toBe(200);
    }

    const readRes = await SELF.fetch(`${BASE}/sessions/${id}`);
    const session = (await readRes.json()) as { eventCount: number };
    expect(session.eventCount).toBe(N);
  });

  it("handles 100 concurrent event POSTs and arrives at exactly 100", { timeout: 60_000 }, async () => {
    // Unique session — isolated from all other tests
    const createRes = await SELF.fetch(`${BASE}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: `user-concurrent-${crypto.randomUUID()}` }),
    });
    expect(createRes.status).toBe(201);
    const { id } = (await createRes.json()) as { id: string };

    // Fire 100 concurrent requests. The DO model serialises them internally
    // via single-writer guarantee — the final count must be exactly 100.
    const N = 100;
    const responses = await Promise.all(
      Array.from({ length: N }, () =>
        SELF.fetch(`${BASE}/sessions/${id}/event`, { method: "POST" })
      )
    );

    // All 100 must succeed — DO serialises without dropping requests at this volume
    const failures = responses.filter((r) => r.status !== 200);
    expect(failures).toHaveLength(0);

    // Read AFTER all writes have resolved — count must be exactly N
    const readRes = await SELF.fetch(`${BASE}/sessions/${id}`);
    const session = (await readRes.json()) as { eventCount: number };
    expect(session.eventCount).toBe(N);
  });
});

// ---------------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------------

describe("RateLimiterDO", () => {
  it("allows requests up to the limit", async () => {
    // Reset first to ensure clean state
    await SELF.fetch(`${BASE}/rate-limit/test-user-rl/reset`, { method: "DELETE" });

    const res = await SELF.fetch(`${BASE}/rate-limit/test-user-rl/check`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { allowed: boolean; currentCount: number };
    expect(body.allowed).toBe(true);
    expect(body.currentCount).toBeGreaterThan(0);
  });

  it("returns current count via /status", async () => {
    const res = await SELF.fetch(`${BASE}/rate-limit/test-user-status/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { currentCount: number; limit: number };
    expect(typeof body.currentCount).toBe("number");
    expect(typeof body.limit).toBe("number");
  });

  it("rejects when limit is exceeded", async () => {
    const key = "test-user-overflow";
    await SELF.fetch(`${BASE}/rate-limit/${key}/reset`, { method: "DELETE" });

    const promises = Array.from({ length: 101 }, () =>
      SELF.fetch(`${BASE}/rate-limit/${key}/check`, { method: "POST" })
    );
    const responses = await Promise.all(promises);
    const statuses = responses.map((r) => r.status);
    const rejections = statuses.filter((s) => s === 429);
    expect(rejections.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// POST /rate-check — spec alias accepting {key, limit, window_seconds}
// ---------------------------------------------------------------------------

describe("POST /rate-check (spec alias)", () => {
  it("allows request and returns allowed=true with remaining and resets_at", async () => {
    const key = `rate-check-test-${crypto.randomUUID()}`;
    const res = await SELF.fetch(`${BASE}/rate-check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, limit: 10, window_seconds: 60 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { allowed: boolean; remaining: number; resets_at: string };
    expect(body.allowed).toBe(true);
    expect(typeof body.remaining).toBe("number");
    expect(body.remaining).toBe(9);
    expect(typeof body.resets_at).toBe("string");
    // resets_at should be a valid ISO timestamp in the future
    expect(new Date(body.resets_at).getTime()).toBeGreaterThan(Date.now() - 5000);
  });

  it("rejects when limit is exceeded", async () => {
    const key = `rate-check-overflow-${crypto.randomUUID()}`;
    // Exhaust limit
    for (let i = 0; i < 3; i++) {
      await SELF.fetch(`${BASE}/rate-check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, limit: 3, window_seconds: 60 }),
      });
    }
    const res = await SELF.fetch(`${BASE}/rate-check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, limit: 3, window_seconds: 60 }),
    });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { allowed: boolean; remaining: number; resets_at: string };
    expect(body.allowed).toBe(false);
    expect(body.remaining).toBe(0);
    expect(typeof body.resets_at).toBe("string");
  });

  it("returns 400 when required fields are missing", async () => {
    const res = await SELF.fetch(`${BASE}/rate-check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "x" }), // missing limit and window_seconds
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

describe("Health", () => {
  it("GET /health returns ok", async () => {
    const res = await SELF.fetch(`${BASE}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });
});
