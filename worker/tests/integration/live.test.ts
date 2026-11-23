import { describe, it, expect, beforeAll } from "vitest";
import { seedDatabase, api } from "../helpers";

describe("live (free legal channel directory)", () => {
  beforeAll(seedDatabase);

  it("lists seeded channels with YouTube ids", async () => {
    const res = await api("GET", "/api/live");
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<{ id: string; name: string; youtube_channel_id: string }>;
    expect(list.length).toBeGreaterThanOrEqual(5);
    const bloomberg = list.find((c) => c.id === "live-bloomberg")!;
    expect(bloomberg.youtube_channel_id).toBe("UCIALMKvObZNtJ6AmdCLP7Lg");
    // Ordered by sort.
    expect(list.map((c) => c.id).slice(0, 2)).toEqual(["live-bloomberg", "live-dw"]);
  });

  it("v1 alias matches", async () => {
    const res = await api("GET", "/api/v1/live");
    expect(res.status).toBe(200);
    expect(((await res.json()) as unknown[]).length).toBeGreaterThanOrEqual(5);
  });
});
