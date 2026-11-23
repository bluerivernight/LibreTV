// Libre — ingest core (M3 Phase 1). Pure DI core, hermetic-testable with no
// external tools: every real side is injected through IngestDeps. The CLI
// (ingest/cli.ts) composes real deps; the hermetic tests (ingest/ingest.test.ts)
// inject fakes typeof the same surface.

/** A single canonical ABR rendition spec in the §9.1 ladder. */
export interface AbrRendition {
  name: string;
  bitrate: number;
  resolution: string;
}

/** Assest-row shape persisted to the D1 `assets` table (seed contract). */
export interface AssetRecord {
  storageKey: string;
  rendition: string;
  container: string;
  durationSeconds: number;
}

/** Outcome of probing the source with ffprobe (°§9.6). */
export interface ProbeResult {
  format: string;
  durationSeconds: number;
  streams: { codecType: string; codecName: string; width?: number; height?: number }[];
}

/** Options accepted by runIngest (snake_case sourcePath/episode keys). */
export interface IngestOptions {
  sourcePath: string;
  episode: string;
  renditions?: string;
  force?: boolean;
  dryRun?: boolean;
}

/** CLI-facing options for the `runIngest(true, options, () => deps)` shape. */
export interface CliIngestOptions extends IngestOptions {
  dir?: string;
  assetPrefix?: string;
  shellOnly?: boolean;
}

/** Injectable side-effecting surface runIngest calls (all other side is pure). */
export interface IngestDeps {
  probe: (sourcePath: string) => Promise<ProbeResult>;
  ffmpegVersion: () => Promise<string>;
  transcode: (sourcePath: string, rendition: AbrRendition, destKey: string) => Promise<number>;
  r2Put: (storageKey: string, body: string | Uint8Array) => Promise<void>;
  assetExists: (storageKey: string) => Promise<boolean>;
  insertAsset: (row: AssetRecord) => Promise<void>;
}

/** Success/failure report returned by runIngest. */
export interface IngestReport {
  ok: boolean;
  episode: string;
  masterKey: string;
  renditionKeys: string[];
  assetRows: AssetRecord[];
}

/** Canonical ladder strings used when callers omit `renditions`. */
export const RENDITIONS_DEFAULT = "720p,480p";

/** §9.1 ladder lookup: rendition name → AbrRendition (720p, 480p seed). */
const RENDITION_TABLE: Record<string, AbrRendition> = {
  "720p": { name: "720p", bitrate: 2_400_000, resolution: "1280x720" },
  "480p": { name: "480p", bitrate: 1_200_000, resolution: "854x480" },
};

function buildLadderText(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/**
 * Build the ABR ladder from a comma-separated rendition string.
 * Empty input or an unknown rendition → IngestError exit 1.
 */
export function buildLadder(renditions: string): AbrRendition[] {
  const names = renditions.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (names.length === 0) throw new IngestError("renditions may not be empty", 1);
  const ladder = names.map((name) => {
    const r = RENDITION_TABLE[name];
    if (!r) throw new IngestError(`unsupported rendition '${name}' — ladder is 720p,480p`, 1);
    return r;
  });
  return ladder;
}

/** §9.1 canonical storage key for a master playlist → media/<dir>/master.m3u8. */
export function storageKeyForMaster(dir: string): string {
  return `media/${dir}/master.m3u8`;
}

/** §9.1 canonical storage key for a rendition playlist → media/<dir>/<rend>/playlist.m3u8. */
export function storageKeyForRendition(dir: string, rend: string): string {
  return `media/${dir}/${rend}/playlist.m3u8`;
}

/** §9.1 canonical storage key for segment i of a rendition → media/<dir>/<rend>/seg%04d.ts. */
export function segmentStorageKeyForRendition(dir: string, rend: string, segIndex: number): string {
  return `media/${dir}/${rend}/seg${String(segIndex).padStart(4, "0")}.ts`;
}

/** Split m3u8 text into non-empty trimmed lines. */
export function parseM3u8Text(text: string): string[] {
  return buildLadderText(text);
}

/** Structurally validate a master playlist (must declare the #EXTM3U + ladder). */
export function validateMaster(text: string): boolean {
  const lines = buildLadderText(text);
  return lines.includes("#EXTM3U") && lines.some((l) => l.startsWith("#EXT-X-STREAM-INF"));
}

/** Validate a rendition playlist and count its target segments. */
export function validateRenditionPlaylist(text: string): { ok: boolean; segs: number } {
  const lines = buildLadderText(text);
  const segs = lines.filter((l) => l.startsWith("#EXTINF")).length;
  return { ok: lines.includes("#EXTM3U") && segs > 0, segs };
}

/** Error carrying a documented stable exit code (the ingest taxonomy). */
export class IngestError extends Error {
  readonly code: number;
  constructor(message: string, code: number) {
    super(message);
    this.name = "IngestError";
    this.code = code;
  }
}

/**
 * Run a full ingest: probe source → check ffmpeg/ffprobe → build ladder →
 * guard duplicate storage keys (exit 5) → transcode each rendition (exit 4 on
 * failure) → push rendition + master playlists to R2 (exit 6 on failure) →
 * insert asset rows into D1 (exit 7 on failure). `dryRun` skips every side
 * effect while still returning the derived canonical keys.
 */
export async function runIngest(deps: IngestDeps, options: IngestOptions): Promise<IngestReport>;
export async function runIngest(mode: true, options: CliIngestOptions, deps: () => IngestDeps): Promise<IngestReport>;
export async function runIngest(
  depsOrMode: IngestDeps | true,
  options: CliIngestOptions,
  getDeps?: () => IngestDeps,
): Promise<IngestReport> {
  let deps: IngestDeps;
  if (depsOrMode === true) {
    if (!getDeps) throw new IngestError("internal: missing deps provider", 1);
    deps = getDeps();
  } else {
    deps = depsOrMode;
  }
  const { sourcePath, episode, renditions = RENDITIONS_DEFAULT, force = false, dryRun = false } = options;
  const plan = buildLadder(renditions);
  const dir = options.dir || sourcePath.replace(/\.[a-z0-9]+$/i, "").replace(/[^a-z0-9]+/gi, "");

  const masterKey = storageKeyForMaster(dir);
  try {
    await deps.probe(sourcePath);
  } catch (err) {
    if (err instanceof IngestError) throw err;
    throw new IngestError(`probe failed for '${sourcePath}'`, 3);
  }
  try {
    await deps.ffmpegVersion();
  } catch (err) {
    if (err instanceof IngestError) throw err;
    throw new IngestError("ffmpeg/ffprobe not available", 2);
  }
  if (!dryRun && (await deps.assetExists(masterKey)) && !force) {
    throw new IngestError(`asset already exists: ${masterKey} (pass --force)`, 5);
  }

  const renditionKeys: string[] = [];
  const assetRows: AssetRecord[] = [];
  for (const rendition of plan) {
    const key = storageKeyForRendition(dir, rendition.name);
    renditionKeys.push(key);
    if (!dryRun) {
      let segs: number;
      try {
        segs = await deps.transcode(sourcePath, rendition, key);
      } catch (err) {
        if (err instanceof IngestError) throw err;
        throw new IngestError(`transcode failed for '${rendition.name}'`, 4);
      }
      try {
        await deps.r2Put(key, "");
      } catch (err) {
        if (err instanceof IngestError) throw err;
        throw new IngestError(`r2 upload failed for '${key}'`, 6);
      }
      assetRows.push({
        storageKey: key,
        rendition: rendition.name,
        container: "ts",
        durationSeconds: segs,
      });
    }
  }

  if (!dryRun) {
    try {
      await deps.r2Put(masterKey, "");
    } catch (err) {
      if (err instanceof IngestError) throw err;
      throw new IngestError(`r2 upload failed for '${masterKey}'`, 6);
    }
    assetRows.push({
      storageKey: masterKey,
      rendition: "master",
      container: "ts",
      durationSeconds: 0,
    });
    try {
      for (const row of assetRows) await deps.insertAsset(row);
    } catch (err) {
      if (err instanceof IngestError) throw err;
      throw new IngestError("d1 insert failed", 7);
    }
  }

  return { ok: true, episode, masterKey, renditionKeys, assetRows };
}
