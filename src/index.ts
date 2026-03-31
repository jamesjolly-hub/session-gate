/**
 * session-gate — Island 2
 *
 * Worker router that dispatches requests to SessionDO or RateLimiterDO
 * based on URL path.
 *
 * Session routes:    /sessions/*
 * Rate-limit routes: /rate-limit/:key/*
 */

import { SessionDO } from "./durable-objects/SessionDO";
import { RateLimiterDO } from "./durable-objects/RateLimiterDO";

export { SessionDO, RateLimiterDO };

export interface Env {
  SESSION_DO: DurableObjectNamespace;
  RATE_LIMITER_DO: DurableObjectNamespace;
  SESSION_TTL_MS: string;
  RATE_LIMIT_MAX: string;
  RATE_LIMIT_WINDOW_MS: string;
  /** Restrict CORS to this origin in production. Defaults to '*' for local dev. */
  ALLOWED_ORIGIN?: string;
}

/**
 * Returns the CORS headers we attach to every response.
 * Restrict ALLOWED_ORIGIN to your frontend domain in production.
 * Set via: npx wrangler secret put ALLOWED_ORIGIN
 */
function corsHeaders(env: Env): HeadersInit {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN ?? "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function addCors(response: Response, env: Env): Response {
  const clone = new Response(response.body, response);
  Object.entries(corsHeaders(env)).forEach(([k, v]) => clone.headers.set(k, v));
  return clone;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    // --- Session routes: /sessions and /sessions/:id/event etc. ---
    if (parts[0] === "sessions") {
      // Route to a fixed "session-store" singleton DO
      // Each session is identified by its ID field inside the DO SQLite table
      const id = env.SESSION_DO.idFromName("session-store");
      const stub = env.SESSION_DO.get(id);

      // Forward the full request path to the DO
      const doRequest = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
      return addCors(await stub.fetch(doRequest), env);
    }

    // --- Rate-limit routes: /rate-limit/:key/check  etc. ---
    if (parts[0] === "rate-limit" && parts[1]) {
      const key = parts[1];
      const subpath = "/" + parts.slice(2).join("/");

      const id = env.RATE_LIMITER_DO.idFromName(key);
      const stub = env.RATE_LIMITER_DO.get(id);

      const doUrl = new URL(request.url);
      doUrl.pathname = subpath || "/check";
      const doRequest = new Request(doUrl.toString(), {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
      return addCors(await stub.fetch(doRequest), env);
    }

    // --- POST /rate-check — spec alias: body {key, limit, window_seconds} ---
    if (request.method === "POST" && url.pathname === "/rate-check") {
      let body: { key?: string; limit?: number; window_seconds?: number };
      try {
        body = (await request.json()) as { key?: string; limit?: number; window_seconds?: number };
      } catch {
        return addCors(Response.json({ error: "Invalid JSON body" }, { status: 400 }), env);
      }
      if (!body.key || body.limit == null || body.window_seconds == null) {
        return addCors(
          Response.json({ error: "key, limit, and window_seconds are required" }, { status: 400 }),
          env
        );
      }

      const id = env.RATE_LIMITER_DO.idFromName(body.key);
      const stub = env.RATE_LIMITER_DO.get(id);

      const doUrl = new URL(request.url);
      doUrl.pathname = "/check-custom";
      doUrl.searchParams.set("limit", String(body.limit));
      doUrl.searchParams.set("windowMs", String(body.window_seconds * 1000));

      const doRequest = new Request(doUrl.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      return addCors(await stub.fetch(doRequest), env);
    }

    // --- POST /session/create — spec alias for POST /sessions ---
    if (request.method === "POST" && url.pathname === "/session/create") {
      const doUrl = new URL(request.url);
      doUrl.pathname = "/sessions";
      const doRequest = new Request(doUrl.toString(), {
        method: "POST",
        headers: request.headers,
        body: request.body,
      });
      const doId = env.SESSION_DO.idFromName("session-store");
      const stub = env.SESSION_DO.get(doId);
      return addCors(await stub.fetch(doRequest), env);
    }

    // --- Singular /session/:id aliases (spec compat) ---
    if (parts[0] === "session" && parts[1]) {
      // POST /session/:id/event  →  POST /sessions/:id/event
      // GET  /session/:id        →  GET  /sessions/:id
      // DELETE /session/:id      →  DELETE /sessions/:id
      const doId = env.SESSION_DO.idFromName("session-store");
      const stub = env.SESSION_DO.get(doId);
      const doUrl = new URL(request.url);
      doUrl.pathname = "/" + ["sessions", ...parts.slice(1)].join("/");
      const doRequest = new Request(doUrl.toString(), {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
      return addCors(await stub.fetch(doRequest), env);
    }

    // --- Health check ---
    if (url.pathname === "/health") {
      return addCors(Response.json({ status: "ok" }), env);
    }

    return addCors(new Response("Not found", { status: 404 }), env);
  },
} satisfies ExportedHandler<Env>;
