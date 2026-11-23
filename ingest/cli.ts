#!/usr/bin/env node
// Libre â€” media ingestion CLI (M3 Phase 1, Â§20). Hermetic wrapper for the pure
// DI core (ingest/lib.ts). Injects real tool adapters â€” ffprobe, ffmpeg -version,
// ffmpeg transcode, `wrangler r2 object put`, and D1 `assets` lookups/inserts
// through the same IngestDeps surface the 9 hermetic vitest tests drive with
// fakes. Node-only: never imported by Worker code (workerd-safe rule).
//
//   node ingest/cli.ts --source <src> --episode <ep> [--dir <d>] [--asset-prefix p]
//                     [--renditions 720p,480p] [--force] [--dry-run] [--shell-only]
//
// Exit codes (shared taxonomy): 0 ok Â· 1 usage Â· 2 missing tool Â· 3 source invalid
// Â· 4 HLS validation failed Â· 5 duplicate storage_key w/o --force Â· 6 R2 upload
// failed Â· 7 D1 write failed.

import { runIngest } from "./lib.js";
import {
  IngestError as InternalIngestError,
  type AbrRendition,
  type IngestDeps as InternalDeps,
  type IngestReport,
  type ProbeResult,
} from "./lib.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";

function die(message: string, code: number): never {
  console.error(`[ingest] ${message}`);
  process.exit(code);
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    } else {
      out[a] = true;
    }
  }
  return out;
}

function run(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

/** Hermetic-ish subprocess runner â€” only the *tools*, no pipeline logic lives here. */
const deps: InternalDeps = {
  async probe(sourcePath) {
    try {
      const { stdout } = await run("ffprobe", [
        "-v", "error", "-print_format", "json",
        "-show_format", "-show_streams", sourcePath,
      ]);
      return JSON.parse(stdout) as ProbeResult;
    } catch {
      throw new InternalIngestError("ffprobe failed â€” source invalid or missing", 3);
    }
  },
  async ffmpegVersion() {
    try {
      const { stdout } = await run("ffmpeg", ["-version"]);
      return stdout.split("\n")[0] ?? "unknown";
    } catch {
      throw new InternalIngestError("ffmpeg not found â€” install ffmpeg (or --shell-only)", 2);
    }
  },
async transcode(sourcePath, rendition, destKey) {
    const outDir = join(tmpdir(), "libre-ingest", rendition.name);
    await fs.mkdir(outDir, { recursive: true });
    const playlist = join(outDir, "playlist.m3u8");
    const [w, h] = rendition.resolution.split("x").map(Number);
    await new Promise<void>((resolve, reject) => {
      const child = spawn("ffmpeg", [
        "-y", "-v", "error", "-i", sourcePath,
        "-c:v", "libx264", "-preset", "veryfast",
        "-vf", `scale=${w}:${h}`,
        "-b:v", String(rendition.bitrate),
        "-c:a", "aac", "-b:a", "128k",
        "-f", "hls", "-hls_time", "2", "-hls_list_size", "0",
        "-hls_segment_filename", join(outDir, "seg%04d.ts"),
        "-hls_playlist_type", "vod", playlist,
      ], { stdio: ["ignore", "ignore", "inherit"] });
      child.on("error", () => reject(new InternalIngestError("ffmpeg spawn failed", 4)));
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new InternalIngestError(`ffmpeg transcode failed (exit ${code})`, 4));
      });
    });
    const names = await fs.readdir(outDir);
    return names.filter((n) => n.endsWith(".ts")).length;
  },
  async r2Put(storageKey, body) {
    try {
      const tmp = join(tmpdir(), "libre-r2-" + storageKey.replace(/[^a-z0-9]+/gi, "_"));
      await fs.writeFile(tmp, body);
      await run("wrangler", ["r2", "object", "put", `libre-media/${storageKey}`, "--file", tmp]);
    } catch {
      throw new InternalIngestError(`r2 object put failed for '${storageKey}'`, 6);
    }
  },
  async assetExists(storageKey) {
    const { stdout } = await run("wrangler", [
      "d1", "execute", "libre-db", "--local", "--json",
      "--command", `SELECT 1 FROM assets WHERE storage_key='${storageKey}' LIMIT 1;`,
    ]);
    return /"results":\[\{/.test(stdout) || /"1"/.test(stdout);
  },
  async insertAsset(row) {
    const esc = (s: string) => s.replace(/'/g, "''");
    const assetId = row.storageKey.replace(/[^a-z0-9]+/gi, "_");
    const sql =
      `INSERT INTO assets (id, episode_id, storage_key, media_type, rendition, container, codecs_json, is_enabled) ` +
      `VALUES ('${esc(assetId)}','','${esc(row.storageKey)}','hls',` +
      `${row.container ? `'${esc(row.container)}'` : "NULL"},` +
      `${row.container === "ts" ? `'${esc(row.rendition ?? "ts")}'` : "NULL"},'{}',1);`;
    try {
      await run("wrangler", ["d1", "execute", "libre-db", "--local", "--command", sql]);
    } catch {
      throw new InternalIngestError("d1 insert failed", 7);
    }
  },
};

function reportFrom(report: IngestReport, dryRun: boolean, shellOnly: boolean) {
  return {
    ok: report.ok,
    dryRun,
    shellOnly,
    episode: report.episode,
    renditions: report.assetRows.filter((r) => r.rendition !== "master").map((r) => r.rendition),
    masterKey: report.masterKey,
    renditionKeys: report.renditionKeys,
    assetCount: report.assetRows.length,
    segmentCount: report.assetRows.filter((r) => r.rendition !== "master").reduce((n, r) => n + r.durationSeconds, 0),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourcePath = typeof args.source === "string" ? args.source : "";
  const episode = typeof args.episode === "string" ? args.episode : "";
  const dir = typeof args.dir === "string" ? args.dir : "";
  if (!sourcePath || !episode) die("usage: ingest/cli.ts --source <src> --episode <ep> [--dir <d>]", 1);

  const renditions = typeof args.renditions === "string" ? args.renditions : undefined;
  const report = await runIngest(true, {
    sourcePath,
    episode,
    dir,
    assetPrefix: typeof args["asset-prefix"] === "string" ? args["asset-prefix"] : undefined,
    renditions,
    force: args.force === true,
    dryRun: args["dry-run"] === true,
    shellOnly: args["shell-only"] === true,
  }, () => deps);
  console.log(JSON.stringify(reportFrom(report, args["dry-run"] === true, args["shell-only"] === true), null, 2));
}

main().catch((err) => {
  if (err instanceof InternalIngestError) {
    console.error(err.message);
    process.exit(err.code);
  }
  console.error(err);
  process.exit(9);
});
