import { describe, it, expect } from "vitest";
import { rewriteMaster, rewriteMedia } from "../../src/routes/playback";
import type { Env } from "../../src/env";
import { HLS_MASTER, HLS_MEDIA } from "../fixtures/hls";

const ASSET = "ast_bbb_01_master";
const STORAGE_KEY_720 = "media/bbb01/720p/playlist.m3u8";

function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    ALLOWED_ORIGINS: "https://libre.tv",
    R2_ACCOUNT_ID: "acct1",
    R2_ACCESS_KEY_ID: "ak",
    R2_SECRET_ACCESS_KEY: "sk",
    PLAYBACK_PRESIGN_TTL_SECONDS: "1800",
    ...overrides,
  } as unknown as Env;
}

describe("playlist rewriting (§12.2)", () => {
  it("rewriteMaster replaces rendition URI lines with Worker media URLs and preserves tags", () => {
    const out = rewriteMaster(HLS_MASTER, ASSET, "https://api.libre.tv", testEnv());
    const lines = out.split("\n");
    expect(lines[0]).toBe("#EXTM3U");
    expect(lines[2]).toContain("#EXT-X-STREAM-INF:");
    expect(lines[3]).toBe("https://api.libre.tv/api/playback/media/ast_bbb_01_master?var=720p");
    expect(lines[5]).toBe("https://api.libre.tv/api/playback/media/ast_bbb_01_master?var=480p");
    expect(out).not.toContain("720p/playlist.m3u8");
  });

  it("rewriteMaster keeps empty lines and in-master comments", () => {
    const out = rewriteMaster("#EXTM3U\n\n#CUSTOM\nseg.m3u8\n", ASSET, "https://api.libre.tv", testEnv());
    const lines = out.split("\n");
    expect(lines[0]).toBe("#EXTM3U");
    expect(lines[1]).toBe("");
    expect(lines[2]).toBe("#CUSTOM");
    expect(lines[3]).toBe("https://api.libre.tv/api/playback/media/ast_bbb_01_master?var=seg.m3u8");
  });

  it("rewriteMedia presigns each segment URI as an absolute R2 URL and preserves tags", async () => {
    const env = testEnv();
    const out = await rewriteMedia(HLS_MEDIA, STORAGE_KEY_720, env, "https://api.libre.tv");
    const lines = out.split("\n");
    expect(lines[0]).toBe("#EXTM3U");
    expect(lines[4]).toBe("#EXTINF:2.0,");

    const segUrl = new URL(lines[5]!);
    expect(segUrl.host).toBe("acct1.r2.cloudflarestorage.com");
    expect(segUrl.pathname).toBe("/media/bbb01/720p/seg000.ts");
    expect(segUrl.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(segUrl.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);

    const seg1Url = new URL(lines[7]!);
    expect(seg1Url.pathname).toBe("/media/bbb01/720p/seg001.ts");
    expect(out).toContain("#EXT-X-ENDLIST");
  });

  it("rewriteMedia substitutes the configured TTL", async () => {
    const env = testEnv({ PLAYBACK_PRESIGN_TTL_SECONDS: "60" });
    const out = await rewriteMedia(HLS_MEDIA, STORAGE_KEY_720, env, "https://api.libre.tv");
    const segUrl = new URL(out.split("\n")[5]!);
    expect(segUrl.searchParams.get("X-Amz-Expires")).toBe("60");
  });

  it("rewriteMedia falls back to Worker segment URLs when R2 credentials are missing", async () => {
    const env = testEnv({ R2_SECRET_ACCESS_KEY: "" });
    const out = await rewriteMedia(HLS_MEDIA, STORAGE_KEY_720, env, "https://api.libre.tv");
    expect(out).toContain("https://api.libre.tv/api/v1/segments/");
    expect(out).not.toContain("#PRESIGN_ERROR");
  });

  it("segmentUrl round-trips through decodeSegmentKey", async () => {
    const { segmentUrl, decodeSegmentKey } = await import("../../src/routes/playback");
    const url = new URL(segmentUrl("https://api.libre.tv", STORAGE_KEY_720));
    expect(url.pathname.startsWith("/api/v1/segments/")).toBe(true);
    expect(decodeSegmentKey(url.pathname.split("/").pop()!)).toBe(STORAGE_KEY_720);
    expect(decodeSegmentKey("!!!")).toBeNull();
  });
});