import { describe, it, expect, beforeAll } from "vitest";
import { env as testEnv } from "cloudflare:test";
import { seedDatabase, api, demoSessionToken } from "../helpers";
import { srtToVtt } from "../../src/routes/subtitles";

const SRT = "1\n00:00:01,000 --> 00:00:02,500\nHello\r\n\r\n2\n00:00:03,000 --> 00:00:04,000\nWorld\n";

beforeAll(async () => {
  await seedDatabase();
  await testEnv.MEDIA_BUCKET.put("media/bbb01/en.srt", SRT);
  await testEnv.DB.prepare(
    "INSERT OR REPLACE INTO subtitles (id, episode_id, language, storage_key, is_default) VALUES (?1, ?2, ?3, ?4, ?5)",
  ).bind("sub_bbb_01_en", "ep_bbb_01", "en", "media/bbb01/en.srt", 1).run();
});

describe("subtitles (§8)", () => {
  it("srtToVtt converts timestamps and adds the header", () => {
    const vtt = srtToVtt(SRT);
    expect(vtt.startsWith("WEBVTT")).toBe(true);
    expect(vtt).toContain("00:00:01.000 --> 00:00:02.500");
    expect(vtt).not.toContain(",");
  });

  it("list is public and returns language rows", async () => {
    const res = await api("GET", "/api/v1/subtitles/ep_bbb_01");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      episode_id: string;
      subtitles: Array<{ id: string; language: string; is_default: boolean }>;
    };
    expect(body.episode_id).toBe("ep_bbb_01");
    expect(body.subtitles).toEqual([{ id: "sub_bbb_01_en", language: "en", is_default: true }]);
  });

  it("list for unknown episode is an empty list (no enumeration)", async () => {
    const res = await api("GET", "/api/v1/subtitles/ep_nope");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { subtitles: unknown[] }).subtitles).toEqual([]);
  });

  it("file without session → 401; gated episode → 403", async () => {
    const anon = await api("GET", "/api/v1/subtitles/file/sub_bbb_01_en");
    expect(anon.status).toBe(401);

    const cookie = await demoSessionToken();
    await testEnv.DB.prepare(
      "INSERT OR REPLACE INTO subtitles (id, episode_id, language, storage_key, is_default) VALUES (?1, ?2, ?3, ?4, ?5)",
    ).bind("sub_gated_en", "ep_gated_01", "en", "media/bbb01/en.srt", 1).run();
    const gated = await api("GET", "/api/v1/subtitles/file/sub_gated_en", { cookie });
    expect(gated.status).toBe(403);
    await testEnv.DB.prepare("DELETE FROM subtitles WHERE id = ?1").bind("sub_gated_en").run();
  });

  it("demo session + free episode → 200 WebVTT", async () => {
    const cookie = await demoSessionToken();
    const res = await api("GET", "/api/v1/subtitles/file/sub_bbb_01_en", { cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/vtt");
    const text = await res.text();
    expect(text.startsWith("WEBVTT")).toBe(true);
    expect(text).toContain("00:00:01.000 --> 00:00:02.500");
  });

  it("unknown subtitle id → 404", async () => {
    const cookie = await demoSessionToken();
    const res = await api("GET", "/api/v1/subtitles/file/sub_nope", { cookie });
    expect(res.status).toBe(404);
  });
});
