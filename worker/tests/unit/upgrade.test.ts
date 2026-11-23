import { describe, it, expect } from "vitest";
import { isUpgradeResponse } from "../../src/index";

// Regression: the CORS middleware rebuilds responses. Rebuilding a 101
// upgrade response drops its webSocket and breaks WebSocket handshakes
// (every browser sends Origin, so every browser handshake failed).
// Detection is status-based: reading `.webSocket` throws on plain responses
// in some runtimes.
describe("upgrade passthrough", () => {
  it("detects 101 upgrade responses only", () => {
    expect(isUpgradeResponse({ status: 101 } as unknown as Response)).toBe(true);
    expect(isUpgradeResponse({ status: 200 } as unknown as Response)).toBe(false);
    expect(isUpgradeResponse({ status: 404 } as unknown as Response)).toBe(false);
    expect(isUpgradeResponse(new Response("{}"))).toBe(false);
  });
});
