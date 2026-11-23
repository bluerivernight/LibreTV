// Libre — import anime catalog rows from AniList (free GraphQL, no key).
//
// Legal metadata only: titles, descriptions, cover art URLs, genres, episode
// counts. AniList provides NO playable streams, so imported rows are metadata
// until you attach your own media via the ingest flow. No rights rows are
// created — grant them explicitly (global or per-user) afterwards.
//
// Usage:
//   node scripts/import-anilist.mjs --query "cowboy bebop" [--out seed-anime.sql]
//   node scripts/import-anilist.mjs --trending [--pages 2] [--out seed-anime.sql]
//   node scripts/import-anilist.mjs --help
//
// Output is an .sql file of INSERT OR REPLACE statements (series, one season
// per show, placeholder episodes "Episode N" — AniList rarely exposes episode
// titles). Apply with:
//   npx wrangler d1 execute libre-db --local --file=seed-anime.sql

const API = "https://graphql.anilist.co";

function help(exit = 0) {
  console.log(`import-anilist.mjs — AniList anime metadata → Libre catalog SQL.

No key needed (public GraphQL API, please be polite: ~90 req/min limit).

Flags:
  --query "text"     search anime by title (up to 10 hits)
  --trending         trending anime instead of a search
  --pages N          trending pages to fetch, 10 titles each (default: 1, max: 5)
  --out FILE         write SQL here (default: stdout)

Notes:
  - Rows use ids anilist-<id>[-s1[-e<N>]].
  - Covers stay remote URLs inside metadata_json (no files copied).
  - Episodes are placeholders ("Episode N", no dates): AniList exposes counts,
    not per-episode titles. Fill real data when you ingest media.
  - No rights rows are emitted: titles show as Locked until you grant rights.`);
  process.exit(exit);
}

function fail(msg) {
  console.error(`import-anilist: ${msg}`);
  process.exit(1);
}

function sqlStr(v) {
  if (v === null || v === undefined) return "NULL";
  return "'" + String(v).replace(/'/g, "''") + "'";
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) help(0);

function arg(name, fallback = null) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}

const QUERY = `
query ($search: String, $page: Int, $sort: [MediaSort]) {
  Page(page: $page, perPage: 10) {
    media(search: $search, type: ANIME, sort: $sort) {
      id
      title { romaji english native }
      description
      coverImage { large }
      bannerImage
      genres
      episodes
      averageScore
      popularity
      format
      startDate { year month day }
    }
  }
}`;

async function fetchPage(variables) {
  const res = await fetch(API, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ query: QUERY, variables }),
    signal: AbortSignal.timeout(30000),
  });
  if (res.status === 429) fail("AniList rate limit hit (429). Wait a minute and retry.");
  if (!res.ok) fail(`AniList → HTTP ${res.status}`);
  const body = await res.json();
  if (body.errors?.length) fail(`AniList: ${body.errors[0].message}`);
  return body.data?.Page?.media ?? [];
}

const stripHtml = (s) =>
  s == null ? null : String(s).replace(/<[^>]*>/g, "").trim() || null;

const now = Math.floor(Date.now() / 1000);
const out = ["-- Libre AniList import (generated, idempotent: INSERT OR REPLACE)."];

const mode = args.includes("--trending") ? "trending" : args.includes("--query") ? "query" : null;
if (!mode) {
  console.error("need --query or --trending (see --help)");
  process.exit(2);
}

const outFile = arg("--out", null);
const pages = Math.min(5, Math.max(1, parseInt(arg("--pages", "1"), 10) || 1));

try {
  const shows = [];
  if (mode === "query") {
    const q = arg("--query", "");
    if (!q) fail("--query needs a search string");
    shows.push(...(await fetchPage({ search: q, page: 1, sort: null })));
  } else {
    for (let p = 1; p <= pages; p++) {
      shows.push(...(await fetchPage({ search: null, page: p, sort: ["TRENDING_DESC"] })));
    }
  }
  if (shows.length === 0) fail("no AniList results");

  for (const m of shows) {
    const name = m.title.english || m.title.romaji || `Anime ${m.id}`;
    const id = `anilist-${m.id}`;
    const meta = {
      anilist_id: m.id,
      kind: "anime",
      format: m.format ?? null,
      poster: m.coverImage?.large ?? null,
      fanart: m.bannerImage ?? null,
      genres: m.genres ?? [],
      // AniList scores are 0-100; the catalog standard is 0-10 (TMDB scale).
      score: typeof m.averageScore === "number" ? Math.round(m.averageScore / 10 * 10) / 10 : null,
      popularity: m.popularity ?? null,
    };
    out.push(
      `INSERT OR REPLACE INTO series (id, name, overview, metadata_json, created_at, updated_at) VALUES (${sqlStr(id)}, ${sqlStr(name)}, ${sqlStr(stripHtml(m.description))}, ${sqlStr(JSON.stringify(meta))}, ${now}, ${now});`,
    );
    const seasonId = `${id}-s1`;
    out.push(
      `INSERT OR REPLACE INTO seasons (id, series_id, season_num, created_at) VALUES (${sqlStr(seasonId)}, ${sqlStr(id)}, 1, ${now});`,
    );
    const count = Math.min(200, Math.max(1, m.episodes ?? 1));
    for (let n = 1; n <= count; n++) {
      out.push(
        `INSERT OR REPLACE INTO episodes (id, season_id, episode_num, title, overview, release_date, runtime_minutes, metadata_json, created_at, updated_at) VALUES (${sqlStr(`${seasonId}e${n}`)}, ${sqlStr(seasonId)}, ${n}, ${sqlStr(`Episode ${n}`)}, NULL, NULL, NULL, NULL, ${now}, ${now});`,
      );
    }
    console.error(`anime    ${name} (${count} episode rows)`);
  }
} catch (err) {
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
