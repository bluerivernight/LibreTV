import { describe, it, expect, beforeAll } from "vitest";
import { seedDatabase, api } from "../helpers";

async function jsonBody(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, any>;
}

describe("people (person detail + filmography)", () => {
  beforeAll(seedDatabase);

  it("returns the person with catalog-resolved credits", async () => {
    const res = await api("GET", "/api/people/tmdb-person-1");
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.name).toBe("Test Actor");
    expect(body.photo_path).toBe("/actor.jpg");
    expect(body.department).toBe("Acting");
    expect(body.imdb_id).toBe("nm0000001");
    expect(body.known_for).toContain("Big Buck Bunny");
    expect(body.credits).toEqual([
      expect.objectContaining({ series_id: "srl_bbb", title: "Big Buck Bunny", character: "Hero (voice)" }),
    ]);
  });

  it("numeric clean URL (/person/1) resolves via tmdb_id", async () => {
    const res = await api("GET", "/api/people/1");
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.name).toBe("Test Actor");
    expect(body.tmdb_id).toBe(1);
  });

  it("unknown person id → 404", async () => {
    const res = await api("GET", "/api/people/nope");
    expect(res.status).toBe(404);
    expect((await jsonBody(res)).error.code).toBe("not_found");
  });
});
