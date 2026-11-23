// Libre — HTTP response helpers.
// JSON error envelope: { error: { code, message } } per implementation map.
// §12.3: expired presigned URLs return 403 with no CORS headers — route re-auth through
// the Worker (this module) so errors always reach the SPA with proper JSON + CORS.

export type JsonInit = ResponseInit & { json: unknown };

/** §API contract — successful JSON response. */
export function json(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** §API contract — error envelope: { error: { code, message } }. */
export function apiError(code: string, message: string, status = 400): Response {
  return json({ error: { code, message } }, status);
}

/** Convenience error wrappers. */
export const notFound    = (msg = "not found")     => apiError("not_found", msg, 404);
export const badRequest  = (msg = "bad request")    => apiError("bad_request", msg, 400);
export const unauthorized = (msg = "unauthenticated") => apiError("no_session", msg, 401);
export const forbidden   = (msg = "forbidden")       => apiError("no_rights", msg, 403);
export const serverError = (msg = "internal error")  => apiError("internal_error", msg, 500);
export const rateLimited = (msg = "rate limit exceeded") => apiError("rate_limited", msg, 429);

/** §9.2 / §12.3 — map R2 presign/access errors to meaningful JSON. */
export function r2Error(err: unknown): Response {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("NoSuchKey")) return notFound("media not found");
  if (msg.includes("ExpiredRequest")) return apiError("expired_presign", "presigned URL expired; re-auth through Worker", 403);
  return serverError(`r2 error: ${msg}`);
}