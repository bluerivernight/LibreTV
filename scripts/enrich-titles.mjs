// Libre — enrich catalog rows with TMDB title data for detail + person pages.
//
// Legal metadata only: cast, member reviews, recommendations, trailer picks and
// person profiles. No playable streams, no rights rows.
//
// Input is a JSON file listing the series to enrich (one entry per row):
//   [{ "id": "tmdb-movie-123", "metadata_json": "{...}" }, ...]
// Produce it from the local D1 (keys never leave your machine):
//   npx wrangler d1 execute libre-db --local --json --command "SELECT id, metadata_json FROM series" > series-raw.json
//   (then extract the result rows into the [{id, metadata_json}] shape)
//
// Env: TMDB_API_KEY (required) — free v3 key, never printed or stored.
//
// Usage:
//   node scripts/enrich-titles.mjs --in series.json --out enrich.sql
//   npx wrangler d1 execute libre-db --local --file=enrich.sql
//
// Notes:
//   - Idempotent: enrichment rows are DELETE + INSERT per series; people rows
//     are INSERT OR REPLACE; series metadata_json is merged and UPDATE'd.
//   - Only TMDB-backed series (tmdb-movie-<id> / tmdb-tv-<id>) are enriched;
//     local/original rows (popeye, namakura, …) are skipped.
//   - Cast is capped at 12 billed, reviews at 6, recommendations at 12.

const API = "https://api.themoviedb.org/3";
const CAST_LIMIT = 12;
const REVIEW_LIMIT = 6;
const RECO_LIMIT = 12;

function help(exit = 0) {
  console.log(`enrich-titles.mjs — TMDB credits/reviews/recs/videos/people → Libre SQL.

Env:  TMDB_API_KEY   (required) free v3 key from themoviedb.org/settings/api

Flags:
  --in FILE        JSON list of [{id, metadata_json}] (required)
  --out FILE       write SQL here (default: stdout)
  --limit N        enrich at most N titles (default: all)
  --skip N         skip the first N titles (resume helper, default: 0)
  --only CSV       subset: credits,reviews,recs,videos,people,meta,stills (default: all)`);
  process.exit(exit);
}

function fail(msg) {
  console.error(`enrich-titles: ${msg}`);
  process.exit(1);
}

function sqlStr(v) {
  if (v === null || v === undefined) return "NULL";
  return "'" + String(v).replace(/'/g, "''") + "'";
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) help(0);

const apiKey = process.env.TMDB_API_KEY;
if (!apiKey) fail("TMDB_API_KEY is not set (see header).");

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
      if (res.status === 404) return null;
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

import { readFileSync, writeFileSync } from "node:fs";

const inFile = arg("--in", null);
if (!inFile) fail("--in FILE is required");
const limit = Math.max(0, parseInt(arg("--limit", "0"), 10) || 0);
const skip = Math.max(0, parseInt(arg("--skip", "0"), 10) || 0);
const outFile = arg("--out", null);
const onlyRaw = (arg("--only", "") ?? "").toLowerCase();
const only = new Set(onlyRaw.split(",").map((s) => s.trim()).filter(Boolean));
const want = (section) => only.size === 0 || only.has(section);

let entries;
try {
  entries = JSON.parse(readFileSync(inFile, "utf8"));
} catch (err) {
  fail(`cannot read ${inFile}: ${err.message}`);
}
if (!Array.isArray(entries)) fail(`${inFile} must be a JSON array`);

// tmdbKey "movie:<tmdbId>" / "tv:<tmdbId>" → catalog series id (for recommendations).
const tmdbToSeries = new Map();
for (const e of entries) {
  try {
    const meta = e.metadata_json ? JSON.parse(e.metadata_json) : null;
    if (meta && meta.tmdb_id && meta.kind) tmdbToSeries.set(`${meta.kind}:${meta.tmdb_id}`, e.id);
  } catch { /* ignore */ }
}

const now = Math.floor(Date.now() / 1000);
const out = ["-- Libre TMDB enrichment (generated, idempotent)."];

function personId(tmdbId) {
  return `tmdb-person-${tmdbId}`;
}

async function enrich(entry) {
  const { id } = entry;
  let meta = {};
  try {
    meta = entry.metadata_json ? JSON.parse(entry.metadata_json) : {};
  } catch {
    meta = {};
  }
  const tmdbId = meta.tmdb_id;
  const kind = meta.kind; // "movie" | "tv"
  if (!tmdbId || (kind !== "movie" && kind !== "tv")) {
    console.error(`skip    ${id} (not TMDB-backed)`);
    return;
  }
  const base = kind === "movie" ? `/movie/${tmdbId}` : `/tv/${tmdbId}`;

  const detail = await get(base);
  await sleep(250);
  if (!detail) {
    console.error(`missing ${id} (TMDB 404)`);
    return;
  }

  // Fresh rows replace stale enrichment for this title (only touched sections).
  if (want("credits") || want("people")) out.push(`DELETE FROM cast_members WHERE series_id = ${sqlStr(id)};`);
  if (want("reviews")) out.push(`DELETE FROM title_reviews WHERE series_id = ${sqlStr(id)};`);
  if (want("recs")) out.push(`DELETE FROM similar_titles WHERE series_id = ${sqlStr(id)};`);
  if (want("videos")) out.push(`DELETE FROM title_videos WHERE series_id = ${sqlStr(id)};`);

  // --- credits + people ---
  const cast = [];
  let order = 0;
  if (want("credits") || want("people")) {
    const credits = await get(`${base}/credits`);
    await sleep(250);
    cast.push(...(((credits && credits.cast) ?? []).slice(0, CAST_LIMIT)));
  }
  for (const c of cast) {
    if (!c.id || !c.name) continue;
    const pid = personId(c.id);
    let profile = c.profile_path ?? null;
    let department = c.known_for_department ?? null;
    let birthday = null;
    let birthplace = null;
    let bio = null;
    let imdb = null;
    if (want("people")) {
      const person = await get(`/person/${c.id}`);
      await sleep(250);
      if (person) {
        profile = person.profile_path ?? profile;
        department = person.known_for_department ?? department;
        birthday = person.birthday ?? null;
        birthplace = person.place_of_birth ?? null;
        bio = person.biography ? person.biography.slice(0, 4000) : null;
        imdb = person.imdb_id ?? null;
      }
    }
    if (want("people")) {
      out.push(
        `INSERT OR REPLACE INTO people (id, tmdb_id, name, photo_path, department, birthday, birthplace, bio, imdb_id, created_at, updated_at) VALUES (${sqlStr(pid)}, ${c.id}, ${sqlStr(c.name)}, ${sqlStr(profile)}, ${sqlStr(department)}, ${sqlStr(birthday)}, ${sqlStr(birthplace)}, ${sqlStr(bio)}, ${sqlStr(imdb)}, ${now}, ${now});`,
      );
    }
    if (want("credits")) {
      out.push(
        `INSERT OR REPLACE INTO cast_members (id, series_id, person_id, character_name, cast_order) VALUES (${sqlStr(`${id}-cast-${order}`)}, ${sqlStr(id)}, ${sqlStr(pid)}, ${sqlStr(c.character ?? null)}, ${order});`,
      );
    }
    order++;
  }

  // --- reviews ---
  let ri = 0;
  if (want("reviews")) {
    const reviewData = await get(`${base}/reviews`, { page: "1" });
    await sleep(250);
    const reviews = ((reviewData && reviewData.results) ?? []).slice(0, REVIEW_LIMIT);
    for (const r of reviews) {
      const content = (r.content ?? "").slice(0, 2000);
      if (!r.author || !content) continue;
      const rating = r.author_details && typeof r.author_details.rating === "number" ? r.author_details.rating : null;
      out.push(
        `INSERT OR REPLACE INTO title_reviews (id, series_id, author, rating, content, created_at, tmdb_review_id) VALUES (${sqlStr(`${id}-rev-${ri}`)}, ${sqlStr(id)}, ${sqlStr(r.author)}, ${rating ?? "NULL"}, ${sqlStr(content)}, ${sqlStr(r.created_at ?? null)}, ${sqlStr(r.id ?? null)});`,
      );
      ri++;
    }
  }

  // --- recommendations (only ones present in our catalog) ---
  let rank = 0;
  if (want("recs")) {
    const recoData = await get(`${base}/recommendations`, { page: "1" });
    await sleep(250);
    const recos = ((recoData && recoData.results) ?? []).slice(0, RECO_LIMIT);
    for (const r of recos) {
      // Recommendations inherit the endpoint kind (movie recs are movies).
      const target = tmdbToSeries.get(`${kind}:${r.id}`);
      if (target && target !== id) {
        out.push(
          `INSERT OR REPLACE INTO similar_titles (series_id, similar_series_id, rank) VALUES (${sqlStr(id)}, ${sqlStr(target)}, ${rank});`,
        );
        rank++;
      }
    }
  }

  // --- trailer ---
  let pick = null;
  if (want("videos")) {
    const videoData = await get(`${base}/videos`);
    await sleep(250);
    const vids = ((videoData && videoData.results) ?? []).filter((v) => v.site === "YouTube" && v.key);
    pick =
      vids.find((v) => v.type === "Trailer" && v.official) ??
      vids.find((v) => v.type === "Trailer") ??
      vids.find((v) => v.type === "Teaser") ??
      vids[0] ?? null;
    if (pick) {
      out.push(
        `INSERT OR REPLACE INTO title_videos (id, series_id, site, video_key, kind, name) VALUES (${sqlStr(`${id}-vid`)}, ${sqlStr(id)}, 'YouTube', ${sqlStr(pick.key)}, ${sqlStr(pick.type ?? "Trailer")}, ${sqlStr(pick.name ?? null)});`,
      );
    }
  }

  // --- enriched series meta (merged, never dropping existing keys) ---
  if (want("meta")) {
    const dateStr = kind === "movie" ? detail.release_date : detail.first_air_date;
    const year = dateStr ? parseInt(String(dateStr).slice(0, 4), 10) : null;
    let runtime = null;
    if (kind === "movie" && typeof detail.runtime === "number") runtime = detail.runtime;
    if (kind === "tv" && Array.isArray(detail.episode_run_time) && typeof detail.episode_run_time[0] === "number") {
      runtime = detail.episode_run_time[0];
    }
    let imdbId = kind === "movie" ? (detail.imdb_id ?? null) : null;
    if (kind === "tv") {
      const ext = await get(`${base}/external_ids`);
      await sleep(250);
      if (ext && ext.imdb_id) imdbId = ext.imdb_id;
    }
    const merged = {
      ...meta,
      tagline: detail.tagline ?? meta.tagline ?? null,
      year: Number.isFinite(year) ? year : (meta.year ?? null),
      runtime_minutes: runtime ?? meta.runtime_minutes ?? null,
      imdb_id: imdbId ?? meta.imdb_id ?? null,
    };
    out.push(
      `UPDATE series SET metadata_json = ${sqlStr(JSON.stringify(merged))}, updated_at = ${now} WHERE id = ${sqlStr(id)};`,
    );
  }

  // --- episode stills (tv only; merged into episode metadata_json) ---
  let stills = 0;
  if (want("stills") && kind === "tv") {
    const IMG_STILL = "https://image.tmdb.org/t/p/w300";
    const seasons = (detail.seasons ?? []).filter((s) => s.season_number >= 0);
    for (const s of seasons) {
      const full = await get(`${base}/season/${s.season_number}`);
      await sleep(250);
      if (!full) continue;
      for (const ep of full.episodes ?? []) {
        if (!ep.still_path || ep.episode_number == null) continue;
        const epId = `${id}-s${s.season_number}e${ep.episode_number}`;
        out.push(
          `UPDATE episodes SET metadata_json = json_set(COALESCE(metadata_json, '{}'), '$.still', ${sqlStr(`${IMG_STILL}${ep.still_path}`)}), updated_at = ${now} WHERE id = ${sqlStr(epId)};`,
        );
        stills++;
      }
    }
  }

  console.error(`enriched ${id} (cast ${order}, reviews ${ri}, similar ${rank}${pick ? ", trailer" : ""}${stills ? `, stills ${stills}` : ""})`);
}

const queue = entries.slice(skip, limit > 0 ? skip + limit : undefined);
for (const entry of queue) {
  await enrich(entry);
}

const sql = `${out.join("\n")}\n`;
if (outFile) {
  writeFileSync(outFile, sql);
  console.error(`\nwrote ${out.length} statements → ${outFile}`);
} else {
  process.stdout.write(sql);
}
