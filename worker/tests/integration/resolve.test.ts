import { describe, it, expect, beforeAll } from "vitest";
import { seedDatabase, api } from "../helpers";

async function jsonBody(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, any>;
}

describe("resolve (clean watch URLs → series ids)", () => {
  beforeAll(seedDatabase);

  it("resolves a tmdb-backed movie by numeric id", async () => {
    const res = await api("GET", "/api/resolve/movie/424242");
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ series_id: "srl_tmdb" });
  });

  it("wrong kind for the same tmdb id → 404", async () => {
    const res = await api("GET", "/api/resolve/tv/424242");
    expect(res.status).toBe(404);
  });

  it("unknown tmdb id → 404", async () => {
    const res = await api("GET", "/api/resolve/movie/999999");
    expect(res.status).toBe(404);
  });

  it("resolves catalog ids via the title kind", async () => {
    const res = await api("GET", "/api/resolve/title/srl_bbb");
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ series_id: "srl_bbb" });
  });

  it("unknown title id → 404", async () => {
    const res = await api("GET", "/api/resolve/title/nope");
    expect(res.status).toBe(404);
  });

  it("bad kind → 400", async () => {
    const res = await api("GET", "/api/resolve/song/123");
    expect(res.status).toBe(400);
    expect((await jsonBody(res)).error.code).toBe("bad_request");
  });

  it("non-numeric id → 400", async () => {
    const res = await api("GET", "/api/resolve/movie/abc");
    expect(res.status).toBe(400);
  });
});
