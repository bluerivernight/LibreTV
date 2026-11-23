// Libre — CORS helpers (§14).
// §14.1: "preflight happens when the browser requires it — not every request"
// Production origin `https://libre.tv`; dev-only `http://localhost:5173`.
// §14: AllowedMethods GET/HEAD; AllowedHeaders Range; expose Content-Length/Content-Range/ETag/Accept-Ranges.

import type { Env } from "../env";

function parseAllowedOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}

/** §14 — If the request origin is allowed, append appropriate CORS response headers. */
export function addCorsHeaders(req: Request, res: Response, env: Env): Response {
  const origin = req.headers.get("Origin");
  if (!origin) return res; // §14.1: no Origin → no CORS headers at all (simple GET, same-origin)

  const allowed = parseAllowedOrigins(env);
  if (!allowed.includes(origin)) return res;

  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", origin);
  h.set("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Range, Content-Type");
  h.set("Access-Control-Expose-Headers", "Content-Length, Content-Range, ETag, Accept-Ranges");
  h.set("Access-Control-Allow-Credentials", "true"); // §14.2 — session cookies are auth credentials
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

/** §14 — Handle CORS preflight (OPTIONS). Returns a Response if preflight handled, or null. */
export function handleCorsPreflight(req: Request, env: Env): Response | null {
  if (req.method !== "OPTIONS") return null;

  const origin = req.headers.get("Origin");
  if (!origin) return new Response(null, { status: 403 });

  const allowed = parseAllowedOrigins(env);
  if (!allowed.includes(origin)) return new Response(null, { status: 403 });

  // §14.2: MaxAgeSeconds 3600 cached preflight
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Range, Content-Type",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Max-Age": "3600",
    },
  });
}