import { describe, it, expect, beforeAll } from "vitest";
import { env as testEnv } from "cloudflare:test";
import { seedDatabase, seedR2, api, demoSessionToken } from "../helpers";
import { segmentUrl } from "../../src/routes/playback";

const SEG_KEY = "media/bbb01/720p/seg0000.ts";
const SEG_BYTES = new Uint8Array([0x47, 0x40, 0x00, 0x10, 0x47, 0x40, 0x00, 0x11]);
const segPath = (key: string) => `/api/v1/segments/${segmentUrl("https://x", key).split("/").pop()}`;

beforeAll(async () => {
  await seedDatabase();
  await seedR2();
  await testEnv.MEDIA_BUCKET.put(SEG_KEY, SEG_BYTES.buffer as ArrayBuffer);
});

describe("segments (dev/no-R2 fallback)", () => {
  it("no session → 401; bad key → 404; unknown key → 404", async () => {
    const cookie = await demoSessionToken();
    expect((await api("GET", segPath(SEG_KEY))).status).toBe(401);
    expect((await api("GET", "/api/v1/segments/!!!", { cookie })).status).toBe(404);
    expect((await api("GET", segPath("media/nope/720p/seg0000.ts"), { cookie })).status).toBe(404);
  });

  it("demo session + free episode segment → 200 video/mp2t with exact bytes", async () => {
    const cookie = await demoSessionToken();
    const res = await api("GET", segPath(SEG_KEY), { cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("video/mp2t");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(SEG_BYTES);
  });

  it("Range request → 206 partial content", async () => {
    const cookie = await demoSessionToken();
    const res = await api("GET", segPath(SEG_KEY), {
      cookie,
      headers: { Range: "bytes=0-3" },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 0-3/${SEG_BYTES.length}`);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(SEG_BYTES.slice(0, 4));
  });

  it("gated episode segment → 403", async () => {
    const cookie = await demoSessionToken();
    await testEnv.MEDIA_BUCKET.put("media/gated01/720p/seg0000.ts", SEG_BYTES.buffer as ArrayBuffer);
    const res = await api("GET", segPath("media/gated01/720p/seg0000.ts"), { cookie });
    expect(res.status).toBe(403);
  });
});
