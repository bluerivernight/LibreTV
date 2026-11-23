import { describe, it, expect, beforeAll } from "vitest";
import { seedDatabase, api } from "../helpers";

// Without a PARTY_ROOM binding in the hermetic test pool, the party HTTP
// layer must degrade to 503 (never 500). Real sync behavior is covered in
// tests/unit/party-do.test.ts against a live PartyRoom with mocked state,
// plus a two-client browser check.
describe("parties (watch rooms)", () => {
  beforeAll(async () => {
    await seedDatabase();
  });

  it("unavailable binding → 503 unavailable (not 500)", async () => {
    const create = await api("POST", "/api/v1/parties", {
      body: { episode_id: "ep_bbb_01" },
    });
    expect([401, 503]).toContain(create.status);
    if (create.status === 503) {
      expect(((await create.json()) as { error: { code: string } }).error.code).toBe(
        "unavailable",
      );
    }
  });
});
