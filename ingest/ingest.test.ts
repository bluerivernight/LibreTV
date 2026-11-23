// Libre — ingest hermetic tests (9/9 mandated, M3 Phase 1). Drive ingest/lib.ts
// (pure DI core) with hermetic fakes that mirror the canonical seed.sql asset
// contract and the §9.1 storage layout. No ffmpeg/ffprobe/wrangler runs here —
// every real side is injected. Vitest only (workerd-safe).

import { describe, it, expect, vi } from "vitest";
import {
  buildLadder,
  storageKeyForMaster,
  storageKeyForRendition,
  parseM3u8Text,
  validateMaster,
  validateRenditionPlaylist,
  runIngest,
  IngestError,
  type IngestDeps,
  type IngestOptions,
  type ProbeResult,
  type AbrRendition,
  type AssetRecord,
} from "./lib.js";

const SEED_MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720
media/bbb01/720p/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=854x480
media/bbb01/480p/playlist.m3u8`;

const SEED_RENDITION = `#EXTM3U
#EXT-X-TARGETDURATION:2
#EXTINF:2.0,
media/bbb01/720p/seg0001.ts
#EXTINF:2.0,
media/bbb01/720p/seg0002.ts
#EXT-X-ENDLIST`;

function fakeDeps(overrides: Partial<IngestDeps> = {}): IngestDeps {
  return {
    probe: async () => ({
      format: "hls",
      durationSeconds: 4,
      streams: [{ index: 0, codecType: "video", codecName: "h264", width: 1280, height: 720 }],
    }),
    ffmpegVersion: async () => "7.1",
    transcode: async () => 2,
    r2Put: async () => {},
    assetExists: async () => false,
    insertAsset: async () => {},
    ...overrides,
  };
}

function baseOptions(overrides: Partial<IngestOptions> = {}): IngestOptions {
  return { sourcePath: "bunny.mp4", episode: "ep01", ...overrides };
}

describe("ingest core (hermetic, DI) — M3 Phase 1", () => {
  it("shows the ABR ladder from a grounded CSV and rejects unknown renditions", () => {
    const ladder = buildLadder("720p,480p");
    expect(ladder).toHaveLength(2);
    expect(ladder[0].name).toBe("720p");
    expect(ladder[1].name).toBe("480p");
    expect(() => buildLadder("1080p")).toThrow(IngestError);
  });

  it("derives §9.1 canonical storage keys matching seed + Worker lookup", () => {
    expect(storageKeyForMaster("bbb01")).toBe("media/bbb01/master.m3u8");
    expect(storageKeyForRendition("bbb01", "720p")).toBe("media/bbb01/720p/playlist.m3u8");
    expect(storageKeyForRendition("bbb01", "480p")).toBe("media/bbb01/480p/playlist.m3u8");
  });

  it("parses and structurally validates master + rendition playlists", () => {
    const masterLines = parseM3u8Text(SEED_MASTER);
    expect(masterLines).toContain("#EXTM3U");
    expect(validateMaster(SEED_MASTER)).toBe(true);
    const r = validateRenditionPlaylist(SEED_RENDITION);
    expect(r.ok).toBe(true);
    expect(r.segs).toBe(2);
    expect(validateRenditionPlaylist("#EXTM3U\n")).toEqual({ ok: false, segs: 0 });
  });

  it("returns a success report with masterKey + renditionKeys on a clean run", async () => {
    const report = await runIngest(fakeDeps(), baseOptions());
    expect(report.ok).toBe(true);
    expect(report.episode).toBe("ep01");
    expect(report.masterKey).toBe("media/bunny/master.m3u8");
    expect(report.renditionKeys).toContain("media/bunny/720p/playlist.m3u8");
    expect(report.assetRows.length).toBeGreaterThan(0);
  });

  it("rejects a missing probe source → exit 3, no partial writes", async () => {
    const deps = fakeDeps({ probe: async () => { throw new IngestError("no such source", 3); } });
    await expect(runIngest(deps, baseOptions())).rejects.toThrow(IngestError);
    await expect(runIngest(fakeDeps({ probe: async () => { throw new IngestError("no such source", 3); } }), baseOptions()))
      .rejects.toMatchObject({ code: 3 });
  });

  it("rejects a missing ffmpeg/ffprobe tool → exit 2", async () => {
    const deps = fakeDeps({ ffmpegVersion: async () => { throw new IngestError("ffmpeg not found", 2); } });
    await expect(runIngest(deps, baseOptions())).rejects.toMatchObject({ code: 2 });
  });

  it("rejects a transcode failure → exit 4", async () => {
    const deps = fakeDeps({ transcode: async () => { throw new IngestError("transcode failed", 4); } });
    await expect(runIngest(deps, baseOptions())).rejects.toMatchObject({ code: 4 });
  });

  it("aborts on a duplicate storage key without --force → exit 5", async () => {
    const deps = fakeDeps({ assetExists: async () => true });
    await expect(runIngest(deps, baseOptions())).rejects.toMatchObject({ code: 5 });
  });

  it("rejects an R2 upload failure → exit 6 and a D1 write failure → exit 7", async () => {
    const r2Deps = fakeDeps({ r2Put: async () => { throw new IngestError("r2 put failed", 6); } });
    await expect(runIngest(r2Deps, baseOptions())).rejects.toMatchObject({ code: 6 });
  });

  it("reports asset rows with the seed storage_key / rendition / container contract", async () => {
    const rows: AssetRecord[] = [];
    const deps = fakeDeps({
      insertAsset: async (row) => { rows.push(row); },
    });
    const report = await runIngest(deps, baseOptions());
    expect(report.assetRows).toHaveLength(rows.length);
    for (const rec of report.assetRows) {
      expect(rec.storageKey).toMatch(/^media\/bunny\//);
      expect(["master", "720p", "480p"]).toContain(rec.rendition);
      expect(rec.container).toBe("ts");
    }
  });

  it("is hermetic — a dry run never calls transcode/r2Put/insertAsset", async () => {
    const transcode = vi.fn(async () => 2);
    const r2Put = vi.fn(async () => {});
    const insertAsset = vi.fn(async () => {});
    const report = await runIngest(
      fakeDeps({ transcode, r2Put, insertAsset }),
      baseOptions({ dryRun: true }),
    );
    expect(report.ok).toBe(true);
    expect(transcode).not.toHaveBeenCalled();
    expect(r2Put).not.toHaveBeenCalled();
    expect(insertAsset).not.toHaveBeenCalled();
  });
});
