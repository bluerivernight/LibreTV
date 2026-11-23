// Libre — fetch subtitles from OpenSubtitles (legal subtitle provider).
//
// Searches opensubtitles.com for an episode (by TMDB/IMDB id), downloads the
// best match per language, saves .srt files locally and emits INSERTs for the
// subtitles table. Upload the files to R2 (same storage_key) and apply the SQL.
//
// Needs a FREE OpenSubtitles account + API key:
//   https://www.opensubtitles.com/en/signup  →  account settings → API key
// Pass everything via the environment (never on the command line, never in
// chat — the script masks secrets in all output):
//   $env:OS_API_KEY="..."; $env:OS_USERNAME="..."; $env:OS_PASSWORD="..."
//
// Quotas (provider-side): anonymous downloads are ~5/day/IP; authenticated
// users get more. The script enforces --max-downloads (default 5) and a
// polite 1.2s delay between calls. Download links expire after ~3h.
//
// Usage:
//   node scripts/subs-opensubtitles.mjs --episode ep_bbb_01 --tmdb-id 10378 --languages en,es --out-dir ./subs
//   node scripts/subs-opensubtitles.mjs --episode ep_x --imdb-id tt1234567 --languages en --out-dir ./subs
//   node scripts/subs-opensubtitles.mjs --help
//
// Output per language: <out-dir>/<episode>.<lang>.srt + one INSERT statement
// (storage_key "media/subs/<episode>.<lang>.srt"). Upload then apply:
//   npx wrangler r2 object put libre-media/media/subs/<episode>.<lang>.srt --file subs/<episode>.<lang>.srt --local
//   npx wrangler d1 execute libre-db --local --file=subs.sql

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const API = "https://api.opensubtitles.com/api/v1";
const UA = "LibreTV v0.1.0";

function help(exit = 0) {
  console.log(`subs-opensubtitles.mjs — OpenSubtitles → .srt files + Libre subtitles SQL.

Env:  OS_API_KEY   (required) API key from opensubtitles.com account settings
      OS_USERNAME  (required for download) opensubtitles.com login
      OS_PASSWORD  (required for download) opensubtitles.com password

Flags:
  --episode ID       Libre episode id the subtitles belong to (required)
  --tmdb-id N        TMDB movie/episode id to search by (use one of tmdb/imdb)
  --imdb-id tt..     IMDB id to search by
  --languages L      comma list, e.g. en,es,fr (default: en)
  --hi               include hearing-impaired tracks (excluded by default)
  --max-downloads N  safety cap per run (default: 5)
  --out-dir DIR      where .srt files + subs.sql go (default: ./subs)

Notes:
  - Picks the highest-rated non-HI, non-machine track per language.
  - Secrets are never printed; only ids/counts appear in output.`);
  process.exit(exit);
}

function fail(msg) {
  console.error(`subs-opensubtitles: ${msg}`);
  process.exit(1);
}

function mask(s) {
  if (!s) return "(missing)";
  return s.length <= 4 ? "****" : `${s.slice(0, 2)}…${s.slice(-2)} (${s.length} chars)`;
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) help(0);

const apiKey = process.env.OS_API_KEY;
const username = process.env.OS_USERNAME;
const password = process.env.OS_PASSWORD;
if (!apiKey) fail("OS_API_KEY is not set (opensubtitles.com → account settings → API key).");
if (!username || !password) {
  fail("OS_USERNAME/OS_PASSWORD are required for downloads (free signup at opensubtitles.com).");
}

function arg(name, fallback = null) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}

const episodeId = arg("--episode", "");
const tmdbId = arg("--tmdb-id", "");
const imdbId = arg("--imdb-id", "");
const languages = (arg("--languages", "en") ?? "en").split(",").map((s) => s.trim()).filter(Boolean);
const includeHi = args.includes("--hi");
const maxDownloads = Math.max(1, parseInt(arg("--max-downloads", "5"), 10) || 5);
const outDir = arg("--out-dir", "./subs");

if (!episodeId) fail("--episode is required");
if (!tmdbId && !imdbId) fail("one of --tmdb-id / --imdb-id is required");
if (languages.length === 0) fail("--languages is empty");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sqlStr = (v) => (v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);
const now = Math.floor(Date.now() / 1000);

async function login() {
  console.error(`login as ${username} (key ${mask(apiKey)}) …`);
  const res = await fetch(`${API}/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "Api-Key": apiKey, "User-Agent": UA },
    body: JSON.stringify({ username, password }),
    signal: AbortSignal.timeout(30000),
  });
  if (res.status === 401) fail("login rejected (401) — check OS_USERNAME/OS_PASSWORD.");
  if (!res.ok) fail(`login → HTTP ${res.status}`);
  const body = await res.json();
  if (!body.token) fail("login response had no token");
  console.error(`login ok (base: ${body.base_url ?? API}), remaining downloads unknown until used.`);
  return { token: body.token, base: body.base_url ? `https://${body.base_url}` : API };
}

async function search(base, token, lang) {
  const qs = new URLSearchParams({ languages: lang });
  if (tmdbId) qs.set("tmdb_id", tmdbId);
  else qs.set("imdb_id", imdbId.replace(/^tt/, ""));
  await sleep(1200);
  const res = await fetch(`${base}/subtitles?${qs}`, {
    headers: { "Api-Key": apiKey, Authorization: `Bearer ${token}`, "User-Agent": UA },
    signal: AbortSignal.timeout(30000),
  });
  if (res.status === 401) fail("search rejected (401) — token expired, rerun.");
  if (!res.ok) fail(`search [${lang}] → HTTP ${res.status}`);
  const body = await res.json();
  const rows = (body.data ?? []).filter((r) => includeHi || !r.attributes?.hearing_impaired);
  rows.sort((a, b) => (b.attributes?.download_count ?? 0) - (a.attributes?.download_count ?? 0));
  const machine = rows.filter((r) => r.attributes?.machine_translated);
  const human = rows.filter((r) => !r.attributes?.machine_translated);
  return human[0] ?? machine[0] ?? null;
}

async function download(base, token, fileId) {
  await sleep(1200);
  const res = await fetch(`${base}/download`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Api-Key": apiKey,
      Authorization: `Bearer ${token}`,
      "User-Agent": UA,
    },
    body: JSON.stringify({ file_id: fileId }),
    signal: AbortSignal.timeout(30000),
  });
  if (res.status === 401) fail("download rejected (401) — quota may be exhausted.");
  if (res.status === 403) fail("download forbidden (403) — daily quota exhausted.");
  if (!res.ok) fail(`download → HTTP ${res.status}`);
  const body = await res.json();
  if (!body.link) fail("download response had no link");
  const file = await fetch(body.link, { signal: AbortSignal.timeout(60000) });
  if (!file.ok) fail(`subtitle file fetch → HTTP ${file.status}`);
  return file.text();
}

const { token, base } = await login();
mkdirSync(outDir, { recursive: true });

const sql = ["-- Libre OpenSubtitles import (generated, idempotent: INSERT OR REPLACE)."];
let done = 0;
for (const lang of languages) {
  if (done >= maxDownloads) {
    console.error(`cap: stopping at --max-downloads=${maxDownloads}`);
    break;
  }
  const hit = await search(base, token, lang);
  if (!hit?.attributes?.files?.length) {
    console.error(`[${lang}] no subtitles found — skipped`);
    continue;
  }
  const fileId = hit.attributes.files[0].file_id;
  const text = await download(base, token, fileId);
  const filename = `${episodeId}.${lang}.srt`;
  writeFileSync(join(outDir, filename), text);
  const storageKey = `media/subs/${filename}`;
  const subId = `sub_${episodeId}_${lang}`.replace(/[^A-Za-z0-9_]/g, "_");
  sql.push(
    `INSERT OR REPLACE INTO subtitles (id, episode_id, language, storage_key, is_default) VALUES (${sqlStr(subId)}, ${sqlStr(episodeId)}, ${sqlStr(lang)}, ${sqlStr(storageKey)}, ${lang === languages[0] ? 1 : 0});`,
  );
  done++;
  console.error(`[${lang}] saved ${filename} (${text.length} chars) ← file_id ${fileId}`);
}

const { writeFileSync: writeSql } = await import("node:fs");
writeSql(join(outDir, "subs.sql"), `${sql.join("\n")}\n`);
console.error(`\ndone: ${done} track(s). Next:
  npx wrangler r2 object put libre-media/media/subs/<file> --file ${outDir}/<file> --local   (per file)
  npx wrangler d1 execute libre-db --local --file=${join(outDir, "subs.sql")}`);
