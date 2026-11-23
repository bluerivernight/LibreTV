// Libre — Media routes (catalog + detail).
// GET /api/media       — list (catalog view)
// GET /api/media/:id   — detail (+ limitations for current session)
// §18: API_LIMITER applied to authenticated endpoints (keyed by userId or IP fallback).

import type { Env } from "../env";
import { param } from "../router";
import { json, notFound, forbidden, rateLimited } from "../util/http";
import { parseSessionCookie } from "../util/sessions";
import { lookupSession } from "../util/sessions";

// -- helpers -------------------------------------------------------------------

async function resolveUserId(req: Request, env: Env): Promise<string | null> {
  const token = parseSessionCookie(req.headers.get("Cookie"));
  if (!token) return null;
  const info = await lookupSession(env.DB, token);
  return info?.isActive ? info.userId : null;
}

async function rateLimit(env: Env, key: string): Promise<boolean> {
  const limiter = env.API_LIMITER;
  if (!limiter) return true;
  const { success } = await limiter.limit({ key });
  return success;
}

// -- handlers ------------------------------------------------------------------

export async function handleMediaList(req: Request, env: Env): Promise<Response> {
  const userId = await resolveUserId(req, env);
  const rateKey = userId ?? `anon:${new URL(req.url).hostname}`;
  if (!(await rateLimit(env, `media-list:${rateKey}`))) return rateLimited();

  // §5: list series with first episode + poster/fanart from metadata_json.
  // Playable = episode has at least one enabled asset AND a rights grant for this session.
  // Series are fetched first and capped, so catalogs with many episodes per
  // series are never truncated by a row-level LIMIT. First episodes, assets
  // and rights resolve in 3 set-based queries (no per-series round trips).
  const seriesRows = await env.DB.prepare(
    `SELECT s.id, s.name, s.overview, s.metadata_json
     FROM series s
     ORDER BY s.name
     LIMIT 100`
  ).all<{ id: string; name: string; overview: string | null; metadata_json: string | null }>();

  const series = seriesRows.results ?? [];
  const firstEps = await env.DB.prepare(
    `SELECT sid, ep_id FROM (
       SELECT sn.series_id AS sid, e.id AS ep_id,
              ROW_NUMBER() OVER (PARTITION BY sn.series_id ORDER BY sn.season_num, e.episode_num) AS rn
       FROM episodes e JOIN seasons sn ON sn.id = e.season_id
     ) WHERE rn = 1`
  ).all<{ sid: string; ep_id: string }>();
  const firstBySeries = new Map((firstEps.results ?? []).map((r) => [r.sid, r.ep_id]));

  const nowTs = Math.floor(Date.now() / 1000);
  const assetRows = await env.DB.prepare(
    "SELECT DISTINCT episode_id AS ep_id FROM assets WHERE is_enabled = 1"
  ).all<{ ep_id: string }>();
  const withAsset = new Set((assetRows.results ?? []).map((r) => r.ep_id));
  const rightsRows = await env.DB.prepare(
    "SELECT DISTINCT episode_id AS ep_id FROM rights r WHERE (r.user_id = ?1 OR r.user_id IS NULL) AND (r.expires_at IS NULL OR r.expires_at > ?2)"
  ).bind(userId ?? "__none__", nowTs).all<{ ep_id: string }>();
  const withRight = new Set((rightsRows.results ?? []).map((r) => r.ep_id));

  const seen = new Map<string, { id: string; title: string; overview: string | null; poster_key: string | null; fanart_key: string | null; logo_key: string | null; kind: string; score: number | null; popularity: number | null; genres: string[]; format: string | null; year: number | null; playable: boolean; first_ep_id: string }>();
  for (const row of series) {
    if (seen.has(row.id)) continue;
    const epId = firstBySeries.get(row.id) ?? "";
    const playable = !!epId && withAsset.has(epId) && withRight.has(epId);
    let poster: string | null = null;
    let fanart: string | null = null;
    let logo: string | null = null;
    let kind = "series";
    let score: number | null = null;
    let popularity: number | null = null;
    let genres: string[] = [];
    let format: string | null = null;
    let year: number | null = null;
    try {
      const meta = row.metadata_json ? JSON.parse(row.metadata_json) : null;
      poster = meta?.poster ?? null;
      fanart = meta?.fanart ?? null;
      logo = meta?.logo ?? null;
      if (typeof meta?.kind === "string" && meta.kind) kind = meta.kind;
      if (typeof meta?.score === "number") score = meta.score;
      if (typeof meta?.popularity === "number") popularity = meta.popularity;
      if (Array.isArray(meta?.genres)) genres = meta.genres.filter((g: unknown) => typeof g === "string");
      if (typeof meta?.format === "string" && meta.format) format = meta.format;
      if (typeof meta?.year === "number") year = meta.year;
    } catch { poster = null; fanart = null; }
    seen.set(row.id, { id: row.id, title: row.name, overview: row.overview, poster_key: poster, fanart_key: fanart, logo_key: logo, kind, score, popularity, genres, format, year, playable, first_ep_id: epId });
  }

  return json([...seen.values()]);
}

export async function handleMediaDetail(req: Request, env: Env, _ctx: ExecutionContext, match: URLPatternResult): Promise<Response> {
  const userId = await resolveUserId(req, env);
  const rateKey = userId ?? `anon:${new URL(req.url).hostname}`;
  if (!(await rateLimit(env, `media-detail:${rateKey}`))) return rateLimited();

  const id = param(match, "id");
  // Accept either a series id (catalog click) or an episode id (search result
  // click — the search route returns episode-backed entries).
  let seriesId: string | null = null;
  const seriesRow = await env.DB.prepare(
    "SELECT id FROM series WHERE id = ?1 LIMIT 1"
  ).bind(id).first<{ id: string }>();
  if (seriesRow) {
    seriesId = seriesRow.id;
  } else {
    const ep = await env.DB.prepare(
      "SELECT season_id FROM episodes WHERE id = ?1 LIMIT 1"
    ).bind(id).first<{ season_id: string }>();
    if (ep) {
      const sea = await env.DB.prepare(
        "SELECT series_id FROM seasons WHERE id = ?1 LIMIT 1"
      ).bind(ep.season_id).first<{ series_id: string }>();
      if (sea) seriesId = sea.series_id;
    }
  }
  if (!seriesId) return notFound("series not found");

  const series = await env.DB.prepare(
    "SELECT id, name, overview, metadata_json FROM series WHERE id = ?1 LIMIT 1"
  ).bind(seriesId).first<{ id: string; name: string; overview: string | null; metadata_json: string | null }>();
  if (!series) return notFound("series not found");

  const seasons = await env.DB.prepare(
    "SELECT id, season_num FROM seasons WHERE series_id = ?1 ORDER BY season_num"
  ).bind(series.id).all<{ id: string; season_num: number }>();

  const nowTs = Math.floor(Date.now() / 1000);
  const seasonsOut: Array<{ id: string; season_num: number; episodes: Array<{
    id: string; episode_num: number; title: string; overview: string | null;
    release_date: string | null; runtime_minutes: number | null; still_key: string | null;
  }> }> = [];

  const playableByEp: Record<string, string[]> = {};
  const reasonsByEp: Record<string, string[]> = {};

  // Bulk episode load: one query for all episodes of the series, then chunked
  // asset/rights lookups (D1 caps bound variables; chunks of 90 stay safe).
  // Per-episode round trips made 30+ season catalogs take 15s+.
  const seasonIds = (seasons.results ?? []).map((s) => s.id);
  const allEps: Array<{
    id: string; season_id: string; episode_num: number; title: string; overview: string | null;
    release_date: string | null; runtime_minutes: number | null; metadata_json: string | null;
  }> = [];
  for (let i = 0; i < seasonIds.length; i += 90) {
    const chunk = seasonIds.slice(i, i + 90);
    const inList = chunk.map((_, n) => `?${n + 1}`).join(",");
    const rows = await env.DB.prepare(
      `SELECT id, season_id, episode_num, title, overview, release_date, runtime_minutes, metadata_json
       FROM episodes WHERE season_id IN (${inList}) ORDER BY episode_num`
    ).bind(...chunk).all<{
      id: string; season_id: string; episode_num: number; title: string; overview: string | null;
      release_date: string | null; runtime_minutes: number | null; metadata_json: string | null;
    }>();
    allEps.push(...(rows.results ?? []));
  }
  const epIds = allEps.map((e) => e.id);
  const assetsByEp = new Map<string, string[]>();
  const rightsSet = new Set<string>();
  for (let i = 0; i < epIds.length; i += 90) {
    const chunk = epIds.slice(i, i + 90);
    if (chunk.length === 0) break;
    const inList = chunk.map((_, n) => `?${n + 1}`).join(",");
    const aRows = await env.DB.prepare(
      `SELECT id, episode_id FROM assets
       WHERE episode_id IN (${inList}) AND media_type = 'hls' AND is_enabled = 1`
    ).bind(...chunk).all<{ id: string; episode_id: string }>();
    for (const a of aRows.results ?? []) {
      const list = assetsByEp.get(a.episode_id) ?? [];
      list.push(a.id);
      assetsByEp.set(a.episode_id, list);
    }
    const off = chunk.length;
    const rInList = chunk.map((_, n) => `?${n + 1}`).join(",");
    const rRows = await env.DB.prepare(
      `SELECT DISTINCT episode_id FROM rights
       WHERE episode_id IN (${rInList}) AND (user_id = ?${off + 1} OR user_id IS NULL)
       AND (expires_at IS NULL OR expires_at > ?${off + 2})`
    ).bind(...chunk, userId ?? "__none__", nowTs).all<{ episode_id: string }>();
    for (const r of rRows.results ?? []) rightsSet.add(r.episode_id);
  }
  for (const ep of allEps) {
    const assets = assetsByEp.get(ep.id) ?? [];
    const reasons: string[] = [];
    if (assets.length === 0) reasons.push("no_media");
    if (!rightsSet.has(ep.id)) reasons.push("no_rights");
    if (reasons.length === 0) playableByEp[ep.id] = assets;
    else reasonsByEp[ep.id] = reasons;
  }

  const epsBySeason = new Map<string, typeof allEps>();
  for (const ep of allEps) {
    const list = epsBySeason.get(ep.season_id) ?? [];
    list.push(ep);
    epsBySeason.set(ep.season_id, list);
  }
  for (const sea of seasons.results ?? []) {
    const eps = epsBySeason.get(sea.id) ?? [];
    seasonsOut.push({
      id: sea.id,
      season_num: sea.season_num,
      episodes: eps.map((ep) => {
        let still: string | null = null;
        try {
          const meta = ep.metadata_json ? JSON.parse(ep.metadata_json) : null;
          still = typeof meta?.still === "string" && meta.still ? meta.still : null;
        } catch { /* leave null */ }
        return {
          id: ep.id,
          episode_num: ep.episode_num,
          title: ep.title,
          overview: ep.overview,
          release_date: ep.release_date,
          runtime_minutes: ep.runtime_minutes,
          still_key: still,
        };
      }),
    });
  }

  let poster: string | null = null;
  let fanart: string | null = null;
  let logo: string | null = null;
  let tagline: string | null = null;
  let year: number | null = null;
  let runtime: number | null = null;
  let imdb: string | null = null;
  let score: number | null = null;
  let genres: string[] = [];
  let kind = "series";
  let tmdbId: number | null = null;
  let anilistId: number | null = null;
  try {
    if (series.metadata_json) {
      const meta = JSON.parse(series.metadata_json);
      poster = meta.poster ?? null;
      fanart = meta.fanart ?? null;
      logo = meta.logo ?? null;
      tagline = meta.tagline ?? null;
      year = typeof meta.year === "number" ? meta.year : null;
      runtime = typeof meta.runtime_minutes === "number" ? meta.runtime_minutes : null;
      imdb = meta.imdb_id ?? null;
      if (typeof meta.score === "number") score = meta.score;
      if (Array.isArray(meta.genres)) genres = meta.genres.filter((g: unknown) => typeof g === "string");
      if (typeof meta.kind === "string" && meta.kind) kind = meta.kind;
      if (typeof meta.tmdb_id === "number") tmdbId = meta.tmdb_id;
      if (typeof meta.anilist_id === "number") anilistId = meta.anilist_id;
    }
  } catch { /* leave null */ }

  // Fallbacks when the importer didn't enrich this row: year/runtime from episodes.
  if (year === null || runtime === null) {
    const eps = await env.DB.prepare(
      `SELECT e.release_date, e.runtime_minutes FROM episodes e
       JOIN seasons sn ON sn.id = e.season_id
       WHERE sn.series_id = ?1 ORDER BY sn.season_num, e.episode_num LIMIT 1`
    ).bind(series.id).first<{ release_date: string | null; runtime_minutes: number | null }>();
    if (eps) {
      if (year === null && eps.release_date) {
        const y = parseInt(eps.release_date.slice(0, 4), 10);
        if (Number.isFinite(y)) year = y;
      }
      if (runtime === null && typeof eps.runtime_minutes === "number") runtime = eps.runtime_minutes;
    }
  }

  // Title enrichment (migration 0002 tables). Missing tables (older DBs that
  // never applied 0002) degrade to empty sections instead of 500s.
  let cast: Array<{ person_id: string; tmdb_id: number | null; name: string; photo_path: string | null; character: string | null }> = [];
  let reviews: Array<{ author: string; rating: number | null; content: string; created_at: string | null; tmdb_review_id: string | null }> = [];
  let reviewCount = 0;
  let trailer: { site: "YouTube"; key: string; kind: string; name: string | null } | null = null;
  let similar: Array<{
    id: string; title: string; overview: string | null; type: "series";
    poster_key: string | null;
    fanart_key: string | null; logo_key: string | null; kind: string;
    score: number | null; popularity: number | null; genres: string[];
    format: string | null; year: number | null; playable: boolean;
  }> = [];
  try {
    const castRows = await env.DB.prepare(
      `SELECT cm.person_id, p.tmdb_id, p.name, p.photo_path, cm.character_name
       FROM cast_members cm JOIN people p ON p.id = cm.person_id
       WHERE cm.series_id = ?1 ORDER BY cm.cast_order LIMIT 15`
    ).bind(series.id).all<{ person_id: string; tmdb_id: number | null; name: string; photo_path: string | null; character_name: string | null }>();
    cast = (castRows.results ?? []).map((r) => ({
      person_id: r.person_id, tmdb_id: r.tmdb_id, name: r.name, photo_path: r.photo_path, character: r.character_name,
    }));
  } catch { /* pre-0002 DB */ }
  try {
    const revRows = await env.DB.prepare(
      `SELECT author, rating, content, created_at, tmdb_review_id FROM title_reviews
       WHERE series_id = ?1 ORDER BY rowid LIMIT 3`
    ).bind(series.id).all<{ author: string; rating: number | null; content: string; created_at: string | null; tmdb_review_id: string | null }>();
    reviews = (revRows.results ?? []).map((r) => ({
      author: r.author, rating: r.rating, content: r.content, created_at: r.created_at,
      tmdb_review_id: r.tmdb_review_id ?? null,
    }));
    const cnt = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM title_reviews WHERE series_id = ?1"
    ).bind(series.id).first<{ n: number }>();
    reviewCount = cnt?.n ?? reviews.length;
  } catch { /* pre-0002 DB */ }
  try {
    const vid = await env.DB.prepare(
      "SELECT site, video_key, kind, name FROM title_videos WHERE series_id = ?1 LIMIT 1"
    ).bind(series.id).first<{ site: string; video_key: string; kind: string; name: string | null }>();
    if (vid && vid.site === "YouTube") {
      trailer = { site: "YouTube", key: vid.video_key, kind: vid.kind, name: vid.name };
    }
  } catch { /* pre-0002 DB */ }
  let simIds: string[] = [];
  try {
    const simRows = await env.DB.prepare(
      `SELECT st.similar_series_id AS sid FROM similar_titles st
       WHERE st.series_id = ?1
       AND EXISTS (SELECT 1 FROM series s WHERE s.id = st.similar_series_id)
       ORDER BY st.rank LIMIT 12`
    ).bind(series.id).all<{ sid: string }>();
    simIds = (simRows.results ?? []).map((r) => r.sid);
  } catch { /* pre-0002 DB */ }
  if (similar.length === 0 && simIds.length === 0) {
    // Fallback: TMDB recommendations rarely overlap a small catalog, so fill
    // "More Like This" with same-kind titles sharing a genre, by popularity.
    try {
      const allRows = await env.DB.prepare(
        "SELECT id, metadata_json FROM series WHERE id != ?1"
      ).bind(series.id).all<{ id: string; metadata_json: string | null }>();
      const scored: Array<{ sid: string; pop: number; shared: number }> = [];
      for (const r of allRows.results ?? []) {
        try {
          const meta = r.metadata_json ? JSON.parse(r.metadata_json) : null;
          if ((meta?.kind ?? "series") !== kind) continue;
          const g: string[] = Array.isArray(meta?.genres) ? meta.genres : [];
          const shared = g.filter((x: string) => genres.includes(x)).length;
          if (genres.length > 0 && shared === 0) continue;
          scored.push({ sid: r.id, pop: typeof meta?.popularity === "number" ? meta.popularity : 0, shared });
        } catch { /* skip */ }
      }
      scored.sort((a, b) => b.shared - a.shared || b.pop - a.pop);
      for (const s of scored.slice(0, 12)) simIds.push(s.sid);
    } catch { /* leave empty */ }
  }
  try {
    if (simIds.length > 0) {
      // Build targeted placeholders (?1..?n) for the IN clause.
      const inList = simIds.map((_, i) => `?${i + 1}`).join(",");
      const rows = await env.DB.prepare(
        `SELECT id, name, overview, metadata_json FROM series WHERE id IN (${inList})`
      ).bind(...simIds).all<{ id: string; name: string; overview: string | null; metadata_json: string | null }>();
      const byId = new Map((rows.results ?? []).map((r) => [r.id, r]));
      for (const sid of simIds) {
        const row = byId.get(sid);
        if (!row) continue;
        let sposter: string | null = null;
        let sfanart: string | null = null;
        let slogo: string | null = null;
        let skind = "series";
        let sscore: number | null = null;
        let spop: number | null = null;
        let sgenres: string[] = [];
        let sformat: string | null = null;
        let syear: number | null = null;
        try {
          const meta = row.metadata_json ? JSON.parse(row.metadata_json) : null;
          sposter = meta?.poster ?? null;
          sfanart = meta?.fanart ?? null;
          slogo = meta?.logo ?? null;
          if (typeof meta?.kind === "string" && meta.kind) skind = meta.kind;
          if (typeof meta?.score === "number") sscore = meta.score;
          if (typeof meta?.popularity === "number") spop = meta.popularity;
          if (Array.isArray(meta?.genres)) sgenres = meta.genres.filter((g: unknown) => typeof g === "string");
          if (typeof meta?.format === "string" && meta.format) sformat = meta.format;
          if (typeof meta?.year === "number") syear = meta.year;
        } catch { /* leave null */ }
        const first = await env.DB.prepare(
          `SELECT e.id FROM episodes e JOIN seasons sn ON sn.id = e.season_id
           WHERE sn.series_id = ?1 ORDER BY sn.season_num, e.episode_num LIMIT 1`
        ).bind(sid).first<{ id: string }>();
        let splayable = false;
        if (first) {
          const asset = await env.DB.prepare(
            "SELECT 1 FROM assets WHERE episode_id = ?1 AND is_enabled = 1 LIMIT 1"
          ).bind(first.id).first();
          const right = await env.DB.prepare(
            "SELECT 1 FROM rights r WHERE r.episode_id = ?1 AND (r.user_id = ?2 OR r.user_id IS NULL) AND (r.expires_at IS NULL OR r.expires_at > ?3) LIMIT 1"
          ).bind(first.id, userId ?? "__none__", nowTs).first();
          splayable = !!asset && !!right;
        }
        similar.push({
          id: row.id, title: row.name, overview: row.overview, type: "series",
          poster_key: sposter, fanart_key: sfanart, logo_key: slogo, kind: skind,
          score: sscore, popularity: spop, genres: sgenres, format: sformat, year: syear, playable: splayable,
        });
      }
    }
  } catch { /* pre-0002 DB */ }

  return json({
    id: series.id,
    name: series.name,
    overview: series.overview,
    poster_key: poster,
    fanart_key: fanart,
    logo_key: logo,
    tagline,
    year,
    runtime_minutes: runtime,
    imdb_id: imdb,
    score,
    genres,
    kind,
    tmdb_id: tmdbId,
    watch_url:
      tmdbId !== null && (kind === "movie" || kind === "tv")
        ? `/watch/${kind}/${tmdbId}`
        : anilistId !== null && kind === "anime"
          ? `/watch/anime/${anilistId}`
          : `/watch/title/${series.id}`,
    cast,
    reviews,
    review_count: reviewCount,
    similar,
    trailer,
    seasons: seasonsOut,
    playable_assets_by_episode: playableByEp,
    limitations: { reasons_by_episode: reasonsByEp },
  });
}