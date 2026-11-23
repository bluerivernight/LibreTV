// Libre — People routes (person detail + filmography).
// GET /api/people/:id — person profile with credits resolved to catalog series.

import type { Env } from "../env";
import { param } from "../router";
import { json, notFound, rateLimited } from "../util/http";

async function rateLimit(env: Env, key: string): Promise<boolean> {
  const limiter = env.API_LIMITER;
  if (!limiter) return true;
  const { success } = await limiter.limit({ key });
  return success;
}

export async function handlePersonDetail(req: Request, env: Env, _ctx: ExecutionContext, match: URLPatternResult): Promise<Response> {
  if (!(await rateLimit(env, `person:${new URL(req.url).hostname}`))) return rateLimited();

  const raw = param(match, "id");
  // Clean numeric URLs (/person/525) resolve via tmdb_id; legacy compound
  // ids (/person/tmdb-person-525) keep working.
  const numeric = /^\d+$/.test(raw);
  let person: {
    id: string; tmdb_id: number | null; name: string; photo_path: string | null; department: string | null;
    birthday: string | null; birthplace: string | null; bio: string | null; imdb_id: string | null;
  } | null = null;
  try {
    person = numeric
      ? await env.DB.prepare(
          `SELECT id, tmdb_id, name, photo_path, department, birthday, birthplace, bio, imdb_id
           FROM people WHERE tmdb_id = ?1 LIMIT 1`
        ).bind(Number(raw)).first<{
          id: string; tmdb_id: number | null; name: string; photo_path: string | null; department: string | null;
          birthday: string | null; birthplace: string | null; bio: string | null; imdb_id: string | null;
        }>()
      : await env.DB.prepare(
          `SELECT id, tmdb_id, name, photo_path, department, birthday, birthplace, bio, imdb_id
           FROM people WHERE id = ?1 LIMIT 1`
        ).bind(raw).first<{
          id: string; tmdb_id: number | null; name: string; photo_path: string | null; department: string | null;
          birthday: string | null; birthplace: string | null; bio: string | null; imdb_id: string | null;
        }>();
  } catch {
    return notFound("person not found");
  }
  if (!person) return notFound("person not found");

  let credits: Array<{
    series_id: string; title: string; poster_key: string | null;
    year: number | null; score: number | null; popularity: number | null;
    kind: string; character: string | null;
  }> = [];
  try {
    const rows = await env.DB.prepare(
      `SELECT cm.series_id, cm.character_name, cm.cast_order,
              s.name, s.metadata_json
       FROM cast_members cm JOIN series s ON s.id = cm.series_id
       WHERE cm.person_id = ?1 ORDER BY cm.cast_order`
    ).bind(person.id).all<{
      series_id: string; character_name: string | null; cast_order: number;
      name: string; metadata_json: string | null;
    }>();
    for (const r of rows.results ?? []) {
      let poster: string | null = null;
      let year: number | null = null;
      let score: number | null = null;
      let popularity: number | null = null;
      let kind = "series";
      try {
        const meta = r.metadata_json ? JSON.parse(r.metadata_json) : null;
        poster = meta?.poster ?? null;
        if (typeof meta?.year === "number") year = meta.year;
        if (typeof meta?.score === "number") score = meta.score;
        if (typeof meta?.popularity === "number") popularity = meta.popularity;
        if (typeof meta?.kind === "string" && meta.kind) kind = meta.kind;
      } catch { /* leave null */ }
      credits.push({
        series_id: r.series_id, title: r.name, poster_key: poster,
        year, score, popularity, kind, character: r.character_name,
      });
    }
  } catch { /* leave empty */ }

  // Frequent collaborators: people credited on the same titles, ranked by how
  // many titles they share. Kept in the Worker so the client stays a thin view.
  let collaborators: Array<{
    id: string; tmdb_id: number | null; name: string; photo_path: string | null;
    department: string | null; shared: number; shows: number; films: number;
  }> = [];
  try {
    const rows = await env.DB.prepare(
      `SELECT p.id, p.tmdb_id, p.name, p.photo_path, p.department,
              COUNT(*) AS shared,
              SUM(CASE WHEN json_extract(s.metadata_json, '$.kind') IN ('tv', 'series') THEN 1 ELSE 0 END) AS shows,
              SUM(CASE WHEN json_extract(s.metadata_json, '$.kind') = 'movie' THEN 1 ELSE 0 END) AS films
       FROM cast_members mine
       JOIN cast_members other
         ON other.series_id = mine.series_id AND other.person_id <> mine.person_id
       JOIN people p ON p.id = other.person_id
       JOIN series s ON s.id = other.series_id
       WHERE mine.person_id = ?1
       GROUP BY p.id
       ORDER BY shared DESC, p.name ASC
       LIMIT 6`
    ).bind(person.id).all<{
      id: string; tmdb_id: number | null; name: string; photo_path: string | null;
      department: string | null; shared: number; shows: number; films: number;
    }>();
    collaborators = (rows.results ?? []).map((r) => ({
      id: r.id,
      tmdb_id: r.tmdb_id,
      name: r.name,
      photo_path: r.photo_path,
      department: r.department,
      shared: Number(r.shared) || 0,
      shows: Number(r.shows) || 0,
      films: Number(r.films) || 0,
    }));
  } catch { /* leave empty */ }

  // Best-known first for the "known for" line; the client re-sorts for filters.
  const knownFor = [...credits]
    .sort((a, b) => (b.popularity ?? -1) - (a.popularity ?? -1))
    .slice(0, 3)
    .map((c) => c.title);

  return json({
    id: person.id,
    tmdb_id: person.tmdb_id,
    name: person.name,
    photo_path: person.photo_path,
    department: person.department,
    birthday: person.birthday,
    birthplace: person.birthplace,
    bio: person.bio,
    imdb_id: person.imdb_id,
    known_for: knownFor,
    credits,
    collaborators,
  });
}
