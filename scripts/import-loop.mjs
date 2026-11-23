// Libre — autonomous catalog import loop.
//
// Pulls trending titles from every keyless-or-keyed provider, validates the
// generated SQL, applies it to D1, and verifies row counts afterwards.
// Designed as a bounded loop: every step retries 3x with backoff, then the
// run aborts with a non-zero exit and a clear reason (no infinite spinning).
//
// Providers:
//   anilist  keyless public GraphQL — always runs
//   tmdb     needs TMDB_API_KEY env (free key) — skipped with a note if absent
//
// Usage (run from the repo root):
//   node scripts/import-loop.mjs [--only anilist|tmdb] [--anime-pages N]
//     [--tmdb-pages N] [--remote] [--help]
//
//   --remote  apply to the production D1 (default: local Miniflare D1)
//   --help    usage
//
// Secrets live in YOUR shell env (TMDB_API_KEY). They are never printed,
// written to files, or embedded in the generated SQL.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_DIR = join(ROOT, "worker");
const WRANGLER_JS = join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
const MAX_TRIES = 3;

function help(exit = 0) {
  console.log(`import-loop.mjs — autonomous trending import with verify + retry cap.

Runs import-anilist (keyless) and import-tmdb (TMDB_API_KEY env), applies
each .sql to D1, then verifies series/episode counts grew as expected.

Flags:
  --only anilist|tmdb   run one provider (default: both)
  --anime-pages N       AniList trending pages, 10 titles each (default: 1)
  --tmdb-pages N        TMDB discover pages per kind, 20 titles each (default: 1)
  --remote              apply to remote D1 (default: local --local D1)
  --help                this text

Exit codes: 0 all green (or TMDB skipped without key), 1 a step failed
after ${MAX_TRIES} tries. Progress goes to stderr; SQL stays in temp files.`);
  process.exit(exit);
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) help(0);

function arg(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}

const only = arg("--only", "all");
const animePages = Math.min(5, Math.max(1, parseInt(arg("--anime-pages", "1"), 10) || 1));
const tmdbPages = Math.min(5, Math.max(1, parseInt(arg("--tmdb-pages", "1"), 10) || 1));
const remote = args.includes("--remote");
if (!["all", "anilist", "tmdb"].includes(only)) {
  console.error("import-loop: --only must be anilist|tmdb");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sh(cmd, cmdArgs, opts = {}) {
  const res = spawnSync(cmd, cmdArgs, { encoding: "utf8", ...opts });
  return { status: res.status ?? 1, out: `${res.stdout ?? ""}\n${res.stderr ?? ""}` };
}

async function withRetry(label, fn) {
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      console.error(`[${label}] attempt ${attempt}/${MAX_TRIES} failed: ${err.message}`);
      if (attempt === MAX_TRIES) throw err;
      await sleep(2000 * attempt);
    }
  }
  throw new Error(`[${label}] exhausted retries`);
}

function d1(args2) {
  // Same trick as scripts/seed-local-r2.mjs: run wrangler's JS entry with node
  // directly — spawning npx.cmd needs a shell on Windows (EINVAL otherwise).
  const res = sh(process.execPath, [WRANGLER_JS, "d1", "execute", "libre-db", ...(remote ? ["--remote"] : ["--local"]), ...args2], {
    cwd: WORKER_DIR,
  });
  if (res.status !== 0) throw new Error(`wrangler d1 failed:\n${res.out.slice(-800)}`);
  return res.out;
}

function d1count(table) {
  const out = d1(["--command", `SELECT COUNT(*) AS c FROM ${table}`, "--json"]);
  const m = /"c":\s*(\d+)/.exec(out);
  if (!m) throw new Error(`could not read count for ${table}`);
  return parseInt(m[1], 10);
}

function sqlSeriesCount(file) {
  const text = readFileSync(file, "utf8");
  return text.split("INSERT OR REPLACE INTO series ").length - 1;
}

// wrangler d1 execute --file chokes on very large files, so big imports are
// split into sequential chunks (applied one at a time, each with retries).
function applySqlFile(file, label) {
  const text = readFileSync(file, "utf8");
  const stmts = text
    .split(";\n")
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("--"));
  const CHUNK = 1000;
  if (stmts.length <= CHUNK) {
    d1(["--file", file]);
    return;
  }
  console.error(`${label}: ${stmts.length} statements → chunked`);
  const dir = join(tmpdir(), `libre-chunk-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  try {
    for (let i = 0; i < stmts.length; i += CHUNK) {
      const part = join(dir, `chunk-${i / CHUNK}.sql`);
      writeFileSync(part, `${stmts.slice(i, i + CHUNK).join(";\n")};\n`);
      d1(["--file", part]);
      console.error(`${label}: chunk ${i / CHUNK + 1}/${Math.ceil(stmts.length / CHUNK)} applied`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const tmp = mkdtempSync(join(tmpdir(), "libre-import-"));
try {
  const before = { series: d1count("series"), episodes: d1count("episodes") };
  console.error(`D1 ${remote ? "remote" : "local"} before: ${before.series} series, ${before.episodes} episodes`);

  // ---- AniList (keyless) ----
  if (only === "all" || only === "anilist") {
    const file = join(tmp, "anime.sql");
    await withRetry("anilist-fetch", async () => {
      const r = sh(process.execPath, [
        join(ROOT, "scripts", "import-anilist.mjs"),
        "--trending", "--pages", String(animePages), "--out", file,
      ], { cwd: ROOT });
      if (r.status !== 0) throw new Error(r.out.slice(-500));
    });
    const n = sqlSeriesCount(file);
    if (n < 1) throw new Error("anilist produced zero series rows");
    console.error(`anilist: ${n} series in file`);
    await withRetry("anilist-apply", async () => {
      applySqlFile(file, "anilist");
    });
  }

  // ---- TMDB (keyed; skip cleanly without a key) ----
  if (only === "all" || only === "tmdb") {
    if (!process.env.TMDB_API_KEY) {
      console.error("tmdb: skipped (TMDB_API_KEY not set in this shell)");
    } else {
      for (const kind of ["movie", "tv"]) {
        const file = join(tmp, `tmdb-${kind}.sql`);
        await withRetry(`tmdb-fetch-${kind}`, async () => {
          const r = sh(process.execPath, [
            join(ROOT, "scripts", "import-tmdb.mjs"),
            "--discover", kind, "--pages", String(tmdbPages), "--out", file,
          ], { cwd: ROOT, env: process.env });
          if (r.status !== 0) throw new Error(r.out.slice(-500));
        });
        const n = sqlSeriesCount(file);
        if (n < 1) throw new Error(`tmdb ${kind} produced zero series rows`);
        console.error(`tmdb ${kind}: ${n} series in file`);
        await withRetry(`tmdb-apply-${kind}`, async () => {
          applySqlFile(file, `tmdb-${kind}`);
        });
        await sleep(1000);
      }
    }
  }

  const after = { series: d1count("series"), episodes: d1count("episodes") };
  console.error(`D1 after: ${after.series} series, ${after.episodes} episodes`);
  if (after.series < before.series || after.episodes < before.episodes) {
    throw new Error("counts went backwards — aborting as failed");
  }
  console.error("import-loop: DONE");
} catch (err) {
  console.error(`import-loop: FAILED — ${err.message}`);
  process.exitCode = 1;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
