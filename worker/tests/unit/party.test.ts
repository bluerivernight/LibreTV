import { describe, it, expect } from "vitest";
import { makeRoomCode, isRoomExpired, pruneMembers, ROOM_TTL_MS } from "../../src/routes/party";
import type { RoomMember } from "../../src/routes/party";

describe("party helpers", () => {
  it("makeRoomCode emits 8 unambiguous chars", () => {
    for (let i = 0; i < 50; i++) {
      const code = makeRoomCode();
      expect(code).toMatch(/^[A-HJKMNP-Z2-9]{8}$/);
    }
    expect(makeRoomCode(() => 0)).toBe("AAAAAAAA");
  });

  it("isRoomExpired honors the 24h TTL", () => {
    const now = 1_700_000_000_000;
    expect(isRoomExpired(now - ROOM_TTL_MS - 1, now)).toBe(true);
    expect(isRoomExpired(now - 1000, now)).toBe(false);
  });

  it("pruneMembers drops stale heartbeats only", () => {
    const now = 1_700_000_000_000;
    const members = new Map<string, RoomMember>([
      ["a", { userId: "a", name: "A", lastSeen: now - 1000 }],
      ["b", { userId: "b", name: "B", lastSeen: now - 60_000 }],
    ]);
    pruneMembers(members, now);
    expect([...members.keys()]).toEqual(["a"]);
  });
});
