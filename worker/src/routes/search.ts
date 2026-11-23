// Libre — Search route (§17, §8.2).
// GET /api/search?q=...        — search titles (episodes collapse to series) + people
// GET /api/v1/search?q=...     — same (§v1 alias)
//
// §17: D1/SQLite FTS5 in MVP; fallback to indexed LIKE.
// FTS5 availability in D1 is RECOMMENDED — UNTESTED; the LIKE fallback ensures correctness
// even if FTS5 is unavailable. People search is a plain LIKE on names
// (migration 0002 table; absent on older DBs → skipped, never 500).

import type { Env } from "../env";
import { json, badRequest, rateLimited } from "../util/http";

interface Hit {
  media_id: string;
  type: "series" | "episode" | "person";
  title: string;
  overview: string | null;
  photo_path: string | null;
  poster_key: string | null;
  year: number | null;
  score: number | null;
}

function titleHit(): Pick<Hit, "type" | "photo_path"> {
  return { type: "series" as const, photo_path: null };
}

// -- episode matching (FTS5, then LIKE) ----------------------------------------
// Both return matching *episode* ids; resolveSeries() collapses them to titles.

async function ftsEpisodeIds(db: Env["DB"], q: string): Promise<string[]> {
  // FTS5 query: wrap each term in double-quotes to avoid special characters breaking MATCH.
  const ftsQuery = q
    .split(/\s+/)
    .filter(Boolean)
    .map(t => `"${t.replace(/"/g, '""')}"`)
    .join(" ");
  if (!ftsQuery) return [];

  try {
    const rows = await db.prepare(
      `SELECT e.id
       FROM episode_fts f
       JOIN episodes e ON e.id = f.episode_id
       WHERE episode_fts MATCH ?1
       ORDER BY rank
       LIMIT 25`
    ).bind(ftsQuery).all<{ id: string }>();

    return (rows.results ?? []).map(r => r.id);
  } catch {
    return []; // §8.2/§17: FTS5 may fail on D1 — delegate to LIKE fallback
  }
}

// -- LIKE fallback -------------------------------------------------------------

async function likeEpisodeIds(db: Env["DB"], q: string): Promise<string[]> {
  const pattern = `%${q}%`;
  const rows = await db.prepare(
    `SELECT e.id
     FROM episodes e
     WHERE e.title LIKE ?1 OR e.overview LIKE ?1
     ORDER BY e.title
     LIMIT 25`
  ).bind(pattern).all<{ id: string }>();

  return (rows.results ?? []).map(r => r.id);
}

// -- episodes → distinct series titles -----------------------------------------

async function resolveSeries(db: Env["DB"], episodeIds: string[]): Promise<Hit[]> {
  if (episodeIds.length === 0) return [];
  const inList = episodeIds.map((_, i) => `?${i + 1}`).join(",");
  const rows = await db.prepare(
    `SELECT DISTINCT s.id, s.name, s.overview, s.metadata_json
     FROM episodes e
     JOIN seasons sn ON sn.id = e.season_id
     JOIN series s ON s.id = sn.series_id
     WHERE e.id IN (${inList})
     LIMIT 12`
  ).bind(...episodeIds).all<{ id: string; name: string; overview: string | null; metadata_json: string | null }>();
  return (rows.results ?? []).map((r) => {
    let poster: string | null = null;
    let year: number | null = null;
    let score: number | null = null;
    try {
      const meta = r.metadata_json ? JSON.parse(r.metadata_json) : null;
      poster = meta?.poster ?? null;
      if (typeof meta?.year === "number") year = meta.year;
      if (typeof meta?.score === "number") score = meta.score;
    } catch { /* leave null */ }
    return {
      media_id: r.id,
      ...titleHit(),
      title: r.name,
      overview: r.overview,
      poster_key: poster,
      year,
      score,
    };
  });
}

// -- people ---------------------------------------------------------------

async function peopleSearch(db: Env["DB"], q: string): Promise<Hit[]> {
  try {
    const rows = await db.prepare(
      `SELECT tmdb_id, name, department, photo_path FROM people
       WHERE name LIKE ?1
       ORDER BY name != ?2 COLLATE NOCASE, name
       LIMIT 8`
    ).bind(`%${q}%`, q).all<{ tmdb_id: number; name: string; department: string | null; photo_path: string | null }>();
    return (rows.results ?? []).map(r => ({
      // Clean numeric id: doubles as the /person/<id> URL.
      media_id: String(r.tmdb_id),
      type: "person" as const,
      title: r.name,
      overview: r.department,
      photo_path: r.photo_path,
      poster_key: null,
      year: null,
      score: null,
    }));
  } catch {
    return []; // pre-0002 DB: no people table yet
  }
}

// -- handler -------------------------------------------------------------------

export async function handleSearch(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  if (!q) return badRequest("query parameter q is required");

  // §18: apply API_LIMITER
  const limiter = env.API_LIMITER;
  if (limiter) {
    const { success } = await limiter.limit({ key: `search:${url.hostname}` });
    if (!success) return rateLimited();
  }

  // §17: try FTS5 first, fallback to LIKE — always yields correct results.
  // Episode matches collapse to their series so results are titles + people.
  let episodeIds = await ftsEpisodeIds(env.DB, q);
  if (!episodeIds.length) episodeIds = await likeEpisodeIds(env.DB, q);
  const [titles, people] = await Promise.all([
    resolveSeries(env.DB, episodeIds),
    peopleSearch(env.DB, q),
  ]);

  return json({ query: q, results: [...titles, ...people] });
}