import { describe, it, expect, beforeAll } from "vitest";
import { seedDatabase, api, demoSessionToken } from "../helpers";

async function jsonBody(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, any>;
}

describe("media (§5 catalog + §9 limitations)", () => {
  beforeAll(seedDatabase);

  describe("GET /api/media (list)", () => {
    it("anonymous list shows both series, with playability reflecting global rights only", async () => {
      const res = await api("GET", "/api/media");
      expect(res.status).toBe(200);
      const list = (await res.json()) as Array<{ id: string; playable: boolean }>;
      expect(list.length).toBeGreaterThanOrEqual(2);
      const bbb = list.find(s => s.id === "srl_bbb")!;
      const gated = list.find(s => s.id === "srl_gated")!;
      expect(bbb.playable).toBe(true);
      expect(gated.playable).toBe(false);
    });

    it("list with a demo session still shows srl_bbb first-episode playability", async () => {
      const cookie = await demoSessionToken();
      const res = await api("GET", "/api/media", { cookie });
      const list = (await res.json()) as Array<{ id: string; playable: boolean }>;
      expect(list.find(s => s.id === "srl_bbb")!.playable).toBe(true);
      expect(list.find(s => s.id === "srl_gated")!.playable).toBe(false);
    });
  });

  describe("GET /api/media/:id (detail)", () => {
    it("anonymous detail for srl_bbb: ep_bbb_01 playable, ep_bbb_02 has a no_rights limitation", async () => {
      const res = await api("GET", "/api/media/srl_bbb");
      expect(res.status).toBe(200);
      const body = await jsonBody(res);
      expect(body.id).toBe("srl_bbb");
      expect(body.seasons.length).toBe(1);
      expect(body.playable_assets_by_episode.ep_bbb_01).toEqual(
        expect.arrayContaining([expect.any(String)]),
      );
      expect(body.limitations.reasons_by_episode.ep_bbb_02).toContain("no_rights");
    });

    it("demo session unlocks ep_bbb_02", async () => {
      const cookie = await demoSessionToken();
      const res = await api("GET", "/api/media/srl_bbb", { cookie });
      expect(res.status).toBe(200);
      const body = await jsonBody(res);
      expect(body.playable_assets_by_episode.ep_bbb_02).toEqual(
        expect.arrayContaining([expect.any(String)]),
      );
      expect(body.limitations.reasons_by_episode.ep_bbb_02).toBeUndefined();
    });

    it("srl_gated is entirely locked to both anonymous and demo", async () => {
      const anon = await api("GET", "/api/media/srl_gated");
      const cookie = await demoSessionToken();
      const authed = await api("GET", "/api/media/srl_gated", { cookie });
      for (const res of [anon, authed]) {
        const body = await jsonBody(res);
        expect(body.limitations.reasons_by_episode.ep_gated_01).toContain("no_rights");
      }
    });

    it("unknown series id → 404", async () => {
      const res = await api("GET", "/api/media/nope");
      expect(res.status).toBe(404);
      expect((await jsonBody(res)).error.code).toBe("not_found");
    });

    it("detail carries title enrichment (meta, cast, review, similar, trailer)", async () => {
      const res = await api("GET", "/api/media/srl_bbb");
      expect(res.status).toBe(200);
      const body = await jsonBody(res);
      expect(body.logo_key).toBe("images/bbb/logo.png");
      expect(body.tagline).toBe("Small hero, big adventure.");
      expect(body.year).toBe(2008);
      expect(body.runtime_minutes).toBe(10);
      expect(body.imdb_id).toBe("tt1254207");
      expect(body.score).toBe(7.8);
      expect(body.genres).toEqual(["Animation", "Comedy"]);
      expect(body.cast).toEqual([
        { person_id: "tmdb-person-1", tmdb_id: 1, name: "Test Actor", photo_path: "/actor.jpg", character: "Hero (voice)" },
      ]);
      expect(body.reviews).toEqual([
        { author: "reviewer1", rating: 9.0, content: expect.any(String), created_at: "2024-01-01", tmdb_review_id: "tmdbrev1" },
      ]);
      expect(body.review_count).toBe(1);
      expect(body.trailer).toEqual({ site: "YouTube", key: "dQw4w9WgXcQ", kind: "Trailer", name: "Official Trailer" });
      expect(body.similar.map((s: { id: string }) => s.id)).toContain("srl_gated");
      expect(body.seasons[0].episodes[0].still_key).toBe("images/bbb/still1.jpg");
    });

    it("tmdb-backed detail carries a clean watch_url; local rows use /watch/title/", async () => {
      const tmdb = await jsonBody(await api("GET", "/api/media/srl_tmdb"));
      expect(tmdb.watch_url).toBe("/watch/movie/424242");
      const local = await jsonBody(await api("GET", "/api/media/srl_bbb"));
      expect(local.watch_url).toBe("/watch/title/srl_bbb");
    });

    it("unenriched titles degrade to empty sections (no 500)", async () => {
      const res = await api("GET", "/api/media/srl_gated");
      expect(res.status).toBe(200);
      const body = await jsonBody(res);
      expect(body.cast).toEqual([]);
      expect(body.reviews).toEqual([]);
      expect(body.similar).toEqual([]);
      expect(body.trailer).toBeNull();
    });
  });
});