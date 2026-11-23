import { describe, it, expect } from "vitest";
import {
  SESSION_COOKIE,
  generateSessionToken,
  sessionCookieSet,
  sessionCookieDelete,
  parseSessionCookie,
} from "../../src/util/sessions";

describe("sessions (pure helpers)", () => {
  it("generateSessionToken returns opaque 32-byte base64url raw + 64-hex hash", async () => {
    const { raw, hash } = await generateSessionToken();
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(raw.length).toBe(43); // ceil(32 * 4 / 3), no padding
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(raw);
  });

  it("sessionCookieSet serializes Secure/HttpOnly/SameSite=Lax with 7-day Max-Age", () => {
    const c = sessionCookieSet("tok123");
    expect(c).toContain(`${SESSION_COOKIE}=tok123`);
    expect(c).toContain("HttpOnly");
    expect(c).toContain("Secure");
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Max-Age=604800");
    expect(c).toContain("Path=/");
  });

  it("sessionCookieDelete clears the cookie with Max-Age=0", () => {
    const c = sessionCookieDelete();
    expect(c).toContain(`${SESSION_COOKIE}=`);
    expect(c).toContain("Max-Age=0");
  });

  it("parseSessionCookie extracts the token among other cookies", () => {
    expect(parseSessionCookie(null)).toBeNull();
    expect(parseSessionCookie("")).toBeNull();
    expect(parseSessionCookie("foo=bar")).toBeNull();
    expect(parseSessionCookie(`${SESSION_COOKIE}=abc; theme=dark`)).toBe("abc");
    expect(parseSessionCookie("theme=dark; lbtv_session=xyz")).toBe("xyz");
  });
});