// Libre — import catalog rows from TMDB (The Movie Database).
//
// Legal metadata only: titles, overviews, dates, poster/backdrop URLs and
// genre names. TMDB provides NO playable streams, so imported rows are
// metadata until you attach your own media via the ingest flow. No rights
// rows are created — grant them explicitly (global or per-user) afterwards.
//
// Needs a FREE TMDB API key (v3 auth, api_key query param):
//   https://www.themoviedb.org/settings/api
// Pass it via the environment (never on the command line, never in chat):
//   $env:TMDB_API_KEY="..."; node scripts/import-tmdb.mjs --query "sintel"
//
// Usage:
//   node scripts/import-tmdb.mjs --query "big buck bunny" [--type movie|tv] [--out seed-tmdb.sql]
//   node scripts/import-tmdb.mjs --discover movie [--pages 2] [--out seed-tmdb.sql]
//   node scripts/import-tmdb.mjs --discover tv [--pages 2] [--out seed-tmdb.sql]
//   node scripts/import-tmdb.mjs --help
//
// Output is an .sql file of INSERT OR REPLACE statements (series, seasons,
// episodes). Apply with:
//   npx wrangler d1 execute libre-db --local --file=seed-tmdb.sql

const API = "https://api.themoviedb.org/3";
const IMG = "https://image.tmdb.org/t/p/w500";
const IMG_FANART = "https://image.tmdb.org/t/p/w1280";
const IMG_LOGO = "https://image.tmdb.org/t/p/original";

/** Official title treatment (transparent PNG) when TMDB has one. */
async function fetchLogo(kind, id) {
  try {
    const data = await get(`/${kind}/${id}/images`, { include_image_language: "en,null" });
    const logos = (data.logos ?? []).filter((l) => l.file_path);
    const en = logos.find((l) => l.iso_639_1 === "en") ?? logos[0];
    return en ? `${IMG_LOGO}${en.file_path}` : null;
  } catch {
    return null;
  }
}

function help(exit = 0) {
  console.log(`import-tmdb.mjs — TMDB metadata → Libre catalog SQL.

Env:  TMDB_API_KEY   (required) free v3 key from themoviedb.org/settings/api

Flags:
  --query "text"     search movies (+ TV when --type tv)
  --type movie|tv    what --query searches (default: movie)
  --discover movie|tv  popular titles instead of a search
  --pages N          discover pages to fetch, 20 titles each (default: 1, max: 5)
  --out FILE         write SQL here (default: stdout)

Notes:
  - Rows use ids tmdb-movie-<id>, tmdb-tv-<id>[-s<season>[-e<episode>]].
  - Posters/backdrops stay remote URLs inside metadata_json (no files copied).
  - No rights rows are emitted: titles show as Locked until you grant rights.
  - TV seasons pull full episode lists (extra API calls, be patient).`);
  process.exit(exit);
}

function fail(msg) {
  console.error(`import-tmdb: ${msg}`);
  process.exit(1);
}

function sqlStr(v) {
  if (v === null || v === undefined) return "NULL";
  return "'" + String(v).replace(/'/g, "''") + "'";
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) help(0);

const apiKey = process.env.TMDB_API_KEY;
if (!apiKey) {
  fail(
    "TMDB_API_KEY is not set. Get a free key at https://www.themoviedb.org/settings/api " +
      "then run with $env:TMDB_API_KEY=\"...\" (the key is never printed or stored).",
  );
}

function arg(name, fallback = null) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path, params = {}, tries = 3) {
  const qs = new URLSearchParams({ api_key: apiKey, ...params }).toString();
  let lastErr = null;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(`${API}${path}?${qs}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(30000),
      });
      if (res.status === 401) fail("TMDB rejected the key (401). Check TMDB_API_KEY.");
      if (res.status === 429) {
        const wait = 3000 * attempt;
        console.error(`tmdb ${path}: rate limited (429), waiting ${wait}ms…`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) fail(`TMDB ${path} → HTTP ${res.status}`);
      return res.json();
    } catch (err) {
      lastErr = err;
      if (err instanceof Error && err.message.startsWith("TMDB")) throw err;
      console.error(`tmdb ${path}: ${err.message} (try ${attempt}/${tries})`);
      await sleep(2000 * attempt);
    }
  }
  fail(`TMDB ${path} unreachable after ${tries} tries: ${lastErr?.message}`);
}

const now = Math.floor(Date.now() / 1000);
const out = ["-- Libre TMDB import (generated, idempotent: INSERT OR REPLACE)."];

async function genreMap(kind) {
  try {
    const data = await get(`/genre/${kind}/list`);
    const map = {};
    for (const g of data.genres ?? []) map[g.id] = g.name;
    return map;
  } catch {
    return {};
  }
}

function emitSeries({ id, name, overview, meta }) {
  out.push(
    `INSERT OR REPLACE INTO series (id, name, overview, metadata_json, created_at, updated_at) VALUES (${sqlStr(id)}, ${sqlStr(name)}, ${sqlStr(overview)}, ${sqlStr(JSON.stringify(meta))}, ${now}, ${now});`,
  );
}

function emitSeason({ id, seriesId, num }) {
  out.push(
    `INSERT OR REPLACE INTO seasons (id, series_id, season_num, created_at) VALUES (${sqlStr(id)}, ${sqlStr(seriesId)}, ${num}, ${now});`,
  );
}

function emitEpisode({ id, seasonId, num, title, overview, date }) {
  out.push(
    `INSERT OR REPLACE INTO episodes (id, season_id, episode_num, title, overview, release_date, runtime_minutes, metadata_json, created_at, updated_at) VALUES (${sqlStr(id)}, ${sqlStr(seasonId)}, ${num}, ${sqlStr(title)}, ${sqlStr(overview)}, ${sqlStr(date)}, NULL, NULL, ${now}, ${now});`,
  );
}

async function importMovie(m, genres) {
  const id = `tmdb-movie-${m.id}`;
  const meta = {
    tmdb_id: m.id,
    kind: "movie",
    poster: m.poster_path ? `${IMG}${m.poster_path}` : null,
    fanart: m.backdrop_path ? `${IMG_FANART}${m.backdrop_path}` : null,
    logo: await fetchLogo("movie", m.id),
    genres: (m.genre_ids ?? []).map((g) => genres[g]).filter(Boolean),
    score: m.vote_average ?? null,
    popularity: m.popularity ?? null,
  };
  emitSeries({ id, name: m.title ?? m.name, overview: m.overview ?? null, meta });
  const seasonId = `${id}-s1`;
  emitSeason({ id: seasonId, seriesId: id, num: 1 });
  const detail = await get(`/movie/${m.id}`);
  emitEpisode({
    id: `${seasonId}e1`,
    seasonId,
    num: 1,
    title: detail.title ?? m.title,
    overview: detail.overview ?? null,
    date: detail.release_date || null,
  });
  console.error(`movie   ${m.title ?? m.name}`);
}

async function importShow(summary, genres) {
  const detail = await get(`/tv/${summary.id}`);
  const id = `tmdb-tv-${detail.id}`;
  const meta = {
    tmdb_id: detail.id,
    kind: "tv",
    poster: detail.poster_path ? `${IMG}${detail.poster_path}` : null,
    fanart: detail.backdrop_path ? `${IMG_FANART}${detail.backdrop_path}` : null,
    logo: await fetchLogo("tv", detail.id),
    genres: (detail.genres ?? []).map((g) => g.name),
    score: detail.vote_average ?? null,
    popularity: detail.popularity ?? null,
  };
  emitSeries({ id, name: detail.name, overview: detail.overview ?? null, meta });
  const seasonList = detail.seasons ?? [];
  for (const s of seasonList) {
    if (s.season_number < 0) continue;
    const seasonId = `${id}-s${s.season_number}`;
    emitSeason({ id: seasonId, seriesId: id, num: s.season_number });
    const full = await get(`/tv/${detail.id}/season/${s.season_number}`);
    await sleep(250);
    for (const ep of full.episodes ?? []) {
      emitEpisode({
        id: `${seasonId}e${ep.episode_number}`,
        seasonId,
        num: ep.episode_number,
        title: ep.name ?? `Episode ${ep.episode_number}`,
        overview: ep.overview ?? null,
        date: ep.air_date || null,
      });
    }
  }
  console.error(`tv      ${detail.name} (${(detail.seasons ?? []).length} seasons)`);
}

const mode = args.includes("--discover") ? "discover" : args.includes("--query") ? "query" : null;
if (!mode) {
  console.error("need --query or --discover (see --help)");
  process.exit(2);
}

const outFile = arg("--out", null);
const pages = Math.min(5, Math.max(1, parseInt(arg("--pages", "1"), 10) || 1));
const type = (arg("--type", "movie") ?? "movie").toLowerCase();
if (!["movie", "tv"].includes(type) && mode === "query") fail("--type must be movie|tv");

try {
  const genres = await genreMap(type === "tv" ? "tv" : "movie");
  if (mode === "query") {
    const q = arg("--query", "");
    if (!q) fail("--query needs a search string");
    const data = await get(type === "tv" ? "/search/tv" : "/search/movie", { query: q });
    const hits = (data.results ?? []).slice(0, 5);
    if (hits.length === 0) fail(`no TMDB results for ${JSON.stringify(q)}`);
    for (const hit of hits) {
      if (type === "tv") await importShow(hit, genres);
      else await importMovie(hit, genres);
      await sleep(250);
    }
  } else {
    const di = args.indexOf("--discover");
    const kind = (args[di + 1] ?? "").toLowerCase();
    if (!["movie", "tv"].includes(kind)) fail("--discover needs movie|tv");
    const g2 = kind === "tv" ? await genreMap("tv") : genres;
    for (let p = 1; p <= pages; p++) {
      const data = await get(`/discover/${kind}`, { sort_by: "popularity.desc", page: String(p) });
      for (const hit of data.results ?? []) {
        if (kind === "tv") await importShow(hit, g2);
        else await importMovie(hit, g2);
        await sleep(250);
      }
    }
  }
} catch (err) {
  if (err instanceof Error && err.message.startsWith("TMDB")) throw err;
  fail(String(err));
}

const sql = `${out.join("\n")}\n`;
if (outFile) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(outFile, sql);
  console.error(`\nwrote ${out.length} statements → ${outFile}`);
  console.error("apply: npx wrangler d1 execute libre-db --local --file=" + outFile);
} else {
  process.stdout.write(sql);
}
