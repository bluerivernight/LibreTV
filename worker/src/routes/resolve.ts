// Libre — watch URL resolver.
// GET /api/resolve/:kind/:id — map a clean watch URL to a catalog series id.
// kinds: movie | tv (TMDB numeric id), anime (AniList numeric id),
// title (catalog series id, for local originals without external ids).

import type { Env } from "../env";
import { param } from "../router";
import { json, notFound, badRequest, rateLimited } from "../util/http";

export async function handleResolve(req: Request, env: Env, _ctx: ExecutionContext, match: URLPatternResult): Promise<Response> {
  const limiter = env.API_LIMITER;
  if (limiter) {
    const { success } = await limiter.limit({ key: `resolve:${new URL(req.url).hostname}` });
    if (!success) return rateLimited();
  }

  const kind = param(match, "kind");
  const raw = param(match, "id");
  if (kind === "title") {
    if (!raw) return badRequest("expected /resolve/title/<series id>");
    try {
      const row = await env.DB.prepare(
        "SELECT id FROM series WHERE id = ?1 LIMIT 1"
      ).bind(raw).first<{ id: string }>();
      if (!row) return notFound("title not in catalog");
      return json({ series_id: row.id });
    } catch {
      return notFound("title not in catalog");
    }
  }
  if ((kind !== "movie" && kind !== "tv" && kind !== "anime") || !/^\d+$/.test(raw)) {
    return badRequest("expected /resolve/(movie|tv|anime|title)/<id>");
  }
  const extId = Number(raw);

  try {
    if (kind === "anime") {
      const row = await env.DB.prepare(
        `SELECT s.id FROM series s
         WHERE json_valid(s.metadata_json)
         AND CAST(json_extract(s.metadata_json, '$.anilist_id') AS INTEGER) = ?1
         LIMIT 1`
      ).bind(extId).first<{ id: string }>();
      if (!row) return notFound("title not in catalog");
      return json({ series_id: row.id });
    }
    const row = await env.DB.prepare(
      `SELECT s.id, s.metadata_json FROM series s
       WHERE json_valid(s.metadata_json)
       AND CAST(json_extract(s.metadata_json, '$.tmdb_id') AS INTEGER) = ?1
       LIMIT 5`
    ).bind(extId).all<{ id: string; metadata_json: string | null }>();
    for (const r of row.results ?? []) {
      try {
        const meta = r.metadata_json ? JSON.parse(r.metadata_json) : null;
        if (meta?.kind === kind) return json({ series_id: r.id });
      } catch { /* keep looking */ }
    }
    return notFound("title not in catalog");
  } catch {
    // Pre-enrichment DBs or malformed rows: resolve stays unavailable, not 500.
    return notFound("title not in catalog");
  }
}
