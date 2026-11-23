import { describe, it, expect, beforeAll } from "vitest";
import { seedDatabase, seedR2, api, demoSessionToken } from "../helpers";

async function jsonBody(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, any>;
}

describe("playback (§10/§12 Model B)", () => {
  beforeAll(async () => {
    await seedDatabase();
    await seedR2();
  });

  const MASTER = "ast_bbb_01_master";
  const RENDITION_720 = "ast_bbb_01_720p";
  const GATED_MASTER = "ast_gated_01_master";

  it("no session → 401 no_session", async () => {
    const res = await api("GET", `/api/playback/${MASTER}`);
    expect(res.status).toBe(401);
    expect((await jsonBody(res)).error.code).toBe("no_session");
  });

  it("expired/garbage cookie → 401", async () => {
    const res = await api("GET", `/api/playback/${MASTER}`, { cookie: "lbtv_session=garbage" });
    expect(res.status).toBe(401);
  });

  it("demo session + public asset → 200 with Worker media URLs in rewritten master", async () => {
    const cookie = await demoSessionToken();
    const res = await api("GET", `/api/playback/${MASTER}`, { cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("mpegurl");
    const text = await res.text();
    expect(text).toContain("#EXTM3U");
    expect(text).toContain("720p");
    expect(text).toContain(`/api/playback/media/${MASTER}?var=720p`);
    expect(text).toContain("480p");
  });

  it("demo session + gated asset (no rights) → 403 no_rights", async () => {
    const cookie = await demoSessionToken();
    const res = await api("GET", `/api/playback/${GATED_MASTER}`, { cookie });
    expect(res.status).toBe(403);
    expect((await jsonBody(res)).error.code).toBe("no_rights");
  });

  it("media endpoint without var → 400", async () => {
    const cookie = await demoSessionToken();
    const res = await api("GET", `/api/playback/media/${RENDITION_720}`, { cookie });
    expect(res.status).toBe(400);
  });

  it("media endpoint + valid var → 200 with presigned R2 segment URLs", async () => {
    const cookie = await demoSessionToken();
    const res = await api("GET", `/api/playback/media/${RENDITION_720}?var=720p`, { cookie });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("#EXTM3U");
    // presigned segment URL uses R2 account + SigV4 signed query params
    const segLine = text.split("\n").find(l => l.startsWith("https://"));
    expect(segLine).toBeDefined();
    const u = new URL(segLine!);
    expect(u.host).toBe("test-account-id.r2.cloudflarestorage.com");
    expect(u.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(u.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
  });

  it("browser chain: master → rewritten media URL → rendition playlist with presigned segments", async () => {
    const cookie = await demoSessionToken();
    const masterRes = await api("GET", `/api/playback/${MASTER}`, { cookie });
    expect(masterRes.status).toBe(200);
    const masterText = await masterRes.text();
    const mediaUrlLine = masterText.split("\n").find(l => l.includes("/api/playback/media/"));
    expect(mediaUrlLine).toBeDefined();

    // the browser follows the rewritten (relative) media URL through the Worker
    const mediaUrl = new URL(mediaUrlLine!, "http://test.local");
    const mediaRes = await api("GET", mediaUrl.pathname + mediaUrl.search, { cookie });
    expect(mediaRes.status).toBe(200);
    const mediaText = await mediaRes.text();
    expect(mediaText).toContain("#EXTM3U");
    expect(mediaText).not.toContain("720p/playlist.m3u8"); // must NOT be the master, rewritten wrongly
    const segLine = mediaText.split("\n").find(l => l.startsWith("https://"));
    expect(segLine).toBeDefined();
    const u = new URL(segLine!);
    expect(u.host).toBe("test-account-id.r2.cloudflarestorage.com");
    expect(u.pathname).toBe("/media/bbb01/720p/seg000.ts");
    expect(u.searchParams.get("X-Amz-Expires")).toBe("1800");
  });

  it("master asset + unknown rendition (var=2160p) → 404", async () => {
    const cookie = await demoSessionToken();
    const res = await api("GET", `/api/playback/media/${MASTER}?var=2160p`, { cookie });
    expect(res.status).toBe(404);
    expect((await jsonBody(res)).error.code).toBe("not_found");
  });

  it("tampered rendition var with path chars → 404 (no traversal)", async () => {
    const cookie = await demoSessionToken();
    const res = await api("GET", `/api/playback/media/${RENDITION_720}?var=${encodeURIComponent("../..")}`, { cookie });
    expect(res.status).toBe(404);
    expect((await jsonBody(res)).error.code).toBe("not_found");
  });

  it("unknown asset → 404", async () => {
    const cookie = await demoSessionToken();
    const res = await api("GET", "/api/playback/ast_no_such_thing", { cookie });
    expect(res.status).toBe(404);
  });

  it("disabled asset → 403", async () => {
    const cookie = await demoSessionToken();
    // disable the asset in D1, then request
    await import("cloudflare:test").then(async ({ env: t }) => {
      await t.DB.prepare("UPDATE assets SET is_enabled = 0 WHERE id = 'ast_bbb_01_master'").run();
    });
    const res = await api("GET", `/api/playback/${MASTER}`, { cookie });
    expect(res.status).toBe(403);
    expect((await jsonBody(res)).error.code).toBe("no_rights");
  });
});