/**
 * Lightweight config-driven HTTP router
 * - Route table with path, method, handler
 * - Public route whitelist (bypass localhost check)
 * - Auto body parsing for POST/PUT
 */

import { parse } from "url";
import type { IncomingMessage, ServerResponse } from "http";
import type { ParsedUrlQuery } from "querystring";
import { setCorsHeaders, handlePreflight, isAllowedOrigin, isLocalHost } from "../middleware/cors.js";

export type RouteContext = { pathname: string; query: ParsedUrlQuery; search: string | null };
export type FallbackContext = { pathname: string; search: string | null };
export type RouteHandler = (req: IncomingMessage, res: ServerResponse, context: RouteContext) => unknown;
export type Route = { path: string; method: string; handler: RouteHandler; public?: boolean };
export type RouterOptions = {
  fallback?: (req: IncomingMessage, res: ServerResponse, context: FallbackContext) => unknown;
  publicFallback?: (pathname: string) => boolean;
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => body += chunk);
    req.on("end", () => resolve(body));
  });
}

export function jsonOk(res: ServerResponse, data: unknown = { ok: true }): void {
  res.setHeader("Content-Type", "application/json");
  res.writeHead(200);
  res.end(JSON.stringify(data));
}

export function jsonErr(res: ServerResponse, code: number, msg: string, _details?: unknown): void {
  res.setHeader("Content-Type", "application/json");
  res.writeHead(code);
  res.end(JSON.stringify({ error: msg }));
}

/**
 * Parse JSON body with error handling, returns parsed object or null
 */
export async function parseJsonBody<T = unknown>(req: IncomingMessage, res: ServerResponse): Promise<T | null> {
  try {
    const raw = await readBody(req);
    const parsed: unknown = JSON.parse(raw || "{}");
    return parsed as T;
  } catch {
    jsonErr(res, 400, "Invalid JSON");
    return null;
  }
}

/**
 * Create router from route config
 * @param {Array<{path: string, method: string, handler: Function, public?: boolean}>} routes
 * @param {Object} options
 * @param {Function} options.fallback - Called when no route matches
 * @returns {Function} HTTP request handler (req, res) => void
 */
export function createRouter(routes: Route[], { fallback, publicFallback }: RouterOptions = {}) {
  // Pre-build lookup map: "METHOD:/path" → { handler, public }
  const exactMap = new Map<string, Route>();
  const prefixRoutes: Array<Route & { prefix: string }> = [];

  for (const route of routes) {
    const methods = route.method === "*" ? ["GET", "POST", "PUT", "DELETE"] : [route.method];
    for (const m of methods) {
      if (route.path.endsWith("/*")) {
        prefixRoutes.push({ ...route, prefix: route.path.slice(0, -2), method: m });
      } else {
        exactMap.set(`${m}:${route.path}`, route);
      }
    }
  }

  // Collect public paths for fast localhost check
  const publicExact = new Set<string>();
  const publicPrefixes: string[] = [];
  for (const route of routes) {
    if (!route.public) continue;
    if (route.path.endsWith("/*")) {
      publicPrefixes.push(route.path.slice(0, -2));
    } else {
      publicExact.add(route.path);
    }
  }

  function isPublic(pathname: string): boolean {
    if (publicExact.has(pathname)) return true;
    if (publicPrefixes.some((p) => pathname.startsWith(p))) return true;
    // Only paths no route claims can be opened up this way; a route keeps its own flag.
    return !!publicFallback && !hasRoute(pathname) && publicFallback(pathname);
  }

  const routedPaths = new Set(routes.map((r) => r.path));
  function hasRoute(pathname: string): boolean {
    return routedPaths.has(pathname) || prefixRoutes.some((r) => pathname.startsWith(r.prefix));
  }

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // A malformed URL (bad percent-encoding) makes parse() throw
    let parsedUrl;
    try { parsedUrl = parse(req.url || "/", true); }
    catch { jsonErr(res, 400, "Bad request"); return; }
    const pathname = parsedUrl.pathname || "/";
    const { search } = parsedUrl;
    const routeIsPublic = isPublic(pathname);
    const origin = req.headers.origin;

    // CORS before any early return, so a refusal is still readable by the UI
    // rather than surfacing as an opaque network error.
    setCorsHeaders(res, { origin, isPublic: routeIsPublic });
    if (handlePreflight(req, res)) return;

    // Localhost guard — block non-public routes from remote/tunnel
    const isTunnel = !!req.headers["cf-connecting-ip"];
    const ra = req.socket.remoteAddress;
    // Include ::ffff:127.0.0.1 (IPv4-mapped IPv6) — Node reports this for some
    // localhost connections and it would otherwise 403 the host UI intermittently.
    const isLocal = ra === "127.0.0.1" || ra === "::1" || ra === "::ffff:127.0.0.1" || ra === "::ffff:0:0:0:1";
    if (!routeIsPublic && (isTunnel || !isLocal)) {
      jsonErr(res, 403, "Forbidden");
      return;
    }

    // The address check above cannot see this case: a page in the user's own
    // browser IS the loopback peer. Only the Origin header distinguishes the
    // host's UI from any other site the user happens to have open.
    if (!routeIsPublic && !isAllowedOrigin(origin)) {
      jsonErr(res, 403, "Forbidden origin");
      return;
    }

    // And a rebound name defeats both of the above — same-origin to itself, so
    // no Origin at all, arriving from loopback. The Host it must keep is what
    // gives it away.
    if (!routeIsPublic && !isLocalHost(req.headers.host)) {
      jsonErr(res, 403, "Forbidden host");
      return;
    }

    // Exact match
    const key = `${req.method}:${pathname}`;
    const route = exactMap.get(key);
    if (route) {
      try {
        await route.handler(req, res, { pathname, query: parsedUrl.query, search });
      } catch (err) {
        console.error("Error:", req.url, err);
        jsonErr(res, 500, err instanceof Error ? err.message : String(err));
      }
      return;
    }

    // Prefix match
    for (const pr of prefixRoutes) {
      if ((pr.method === req.method) && pathname.startsWith(pr.prefix)) {
        try {
          await pr.handler(req, res, { pathname, query: parsedUrl.query, search });
        } catch (err) {
          console.error("Error:", req.url, err);
          jsonErr(res, 500, err instanceof Error ? err.message : String(err));
        }
        return;
      }
    }

    // Fallback (static files, etc.)
    if (fallback) {
      try {
        await fallback(req, res, { pathname, search });
      } catch (err) {
        console.error("Error:", req.url, err);
        jsonErr(res, 500, err instanceof Error ? err.message : String(err));
      }
      return;
    }

    jsonErr(res, 404, "Not found");
  };
}
