import { describe, it, expect, beforeAll } from "vitest";
import { seedDatabase, api } from "../helpers";

async function jsonBody(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, any>;
}

describe("search (§17 FTS5 + LIKE fallback)", () => {
  beforeAll(seedDatabase);

  it("q=Sintel returns the Big Buck Bunny title (episodes collapse to series)", async () => {
    const res = await api("GET", "/api/search?q=Sintel");
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.query).toBe("Sintel");
    const hit = body.results.find((r: { media_id: string }) => r.media_id === "srl_bbb");
    expect(hit).toMatchObject({ type: "series", title: "Big Buck Bunny" });
  });

  it("q=paywalled returns the gated title (search is catalog-level, not rights-filtered)", async () => {
    const res = await api("GET", "/api/search?q=paywalled");
    const body = await jsonBody(res);
    const ids = body.results.map((r: { media_id: string }) => r.media_id);
    expect(ids).toContain("srl_gated");
  });

  it("q=per user (multi-term) matches Big Buck Bunny via FTS5 implicit AND", async () => {
    const res = await api("GET", "/api/search?q=per+user");
    const body = await jsonBody(res);
    const ids = body.results.map((r: { media_id: string }) => r.media_id);
    expect(ids).toContain("srl_bbb");
  });

  it("empty q → 400 bad_request", async () => {
    const res = await api("GET", "/api/search?q=");
    expect(res.status).toBe(400);
    expect((await jsonBody(res)).error.code).toBe("bad_request");
  });

  it("no q param at all → 400", async () => {
    const res = await api("GET", "/api/search");
    expect(res.status).toBe(400);
  });

  it("garbage query with no FTS match falls back to LIKE and returns empty results (not 500)", async () => {
    const res = await api("GET", "/api/search?q=zzzznonexistent");
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.results.length).toBe(0);
  });

  it("q=Test Actor returns the seeded person with a photo path", async () => {
    const res = await api("GET", "/api/search?q=Test%20Actor");
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    const hit = body.results.find((r: { type: string }) => r.type === "person");
    expect(hit).toMatchObject({
      media_id: "1",
      title: "Test Actor",
      photo_path: "/actor.jpg",
    });
  });
});