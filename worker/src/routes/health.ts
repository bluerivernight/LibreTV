// Libre — GET /api/health (mandated endpoint).
// §5: minimal liveness probe returning status, service name, and timestamp.
// §18: rate limiting NOT applied to health (abuse-prevention irrelevant for liveness).

import { json } from "../util/http";

export async function handleHealth(): Promise<Response> {
  return json({ status: "ok", service: "libre-api", ts: Math.floor(Date.now() / 1000) });
}