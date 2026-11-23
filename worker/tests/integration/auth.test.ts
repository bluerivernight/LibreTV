import { describe, it, expect, beforeAll } from "vitest";
import { seedDatabase, api, demoSessionToken } from "../helpers";

function parseSetCookie(res: Response): string | null {
  const sc = res.headers.get("Set-Cookie");
  if (!sc) return null;
  const m = sc.match(/lbtv_session=([^;]+)/);
  return m?.[1] ?? null;
}

// §10 wire contract — n/a. Session cookies here are opaque tokens (no JWT, no KV).
async function jsonBody(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, any>;
}

describe("auth (§7)", () => {
  beforeAll(seedDatabase);

  describe("login", () => {
    it("returns 200 + session cookie for valid demo credentials", async () => {
      const res = await api("POST", "/api/auth/login", { body: { email: "demo@libre.tv", password: "demo-pass-2026" } });
      expect(res.status).toBe(200);
      const body = await jsonBody(res);
      expect(body.authenticated).toBe(true);
      expect(body.user.email).toBe("demo@libre.tv");
      const cookie = res.headers.get("Set-Cookie") ?? "";
      expect(cookie).toContain("lbtv_session=");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("Secure");
      expect(cookie).toContain("SameSite=Lax");
    });

    it("rejects a wrong password with 401 invalid credentials", async () => {
      const res = await api("POST", "/api/auth/login", { body: { email: "demo@libre.tv", password: "wrong-password" } });
      expect(res.status).toBe(401);
      const body = await jsonBody(res);
      expect(body.error.message).toBe("invalid credentials");
    });

    it("rejects an unknown email with 401", async () => {
      const res = await api("POST", "/api/auth/login", { body: { email: "nobody@libre.tv", password: "whatever123" } });
      expect(res.status).toBe(401);
    });

    it("rejects missing fields with 400", async () => {
      const res = await api("POST", "/api/auth/login", { body: { email: "demo@libre.tv" } });
      expect(res.status).toBe(400);
    });

    it("rejects accounts marked inactive with 403 account disabled", async () => {
      await seedDatabase();
      await api("POST", "/api/auth/login", { body: { email: "demo@libre.tv", password: "demo-pass-2026" } });
      // deactivate, then login must fail
      await import("cloudflare:test").then(async ({ env: t }) => {
        await t.DB.prepare("UPDATE users SET is_active = 0 WHERE id = 'usr_demo'").run();
      });
      const res = await api("POST", "/api/auth/login", { body: { email: "demo@libre.tv", password: "demo-pass-2026" } });
      expect(res.status).toBe(403);
      const body = await jsonBody(res);
      expect(body.error.message).toBe("account disabled");
      // re-enable so subsequent tests are not poisoned
      await import("cloudflare:test").then(async ({ env: t }) => {
        await t.DB.prepare("UPDATE users SET is_active = 1 WHERE id = 'usr_demo'").run();
      });
    });
  });

  describe("session", () => {
    it("returns unauthenticated when no cookie is present", async () => {
      const res = await api("GET", "/api/auth/session");
      expect(res.status).toBe(200);
      const body = await jsonBody(res);
      expect(body.authenticated).toBe(false);
      expect(body.user).toBeNull();
    });

    it("hydrates the demo user from a valid cookie", async () => {
      const cookie = await demoSessionToken();
      const res = await api("GET", "/api/auth/session", { cookie });
      expect(res.status).toBe(200);
      const body = await jsonBody(res);
      expect(body.authenticated).toBe(true);
      expect(body.user.email).toBe("demo@libre.tv");
      expect(body.user.is_admin).toBe(false);
      expect(typeof body.expires_at).toBe("number");
    });

    it("treats a garbage cookie as unauthenticated", async () => {
      const res = await api("GET", "/api/auth/session", { cookie: "lbtv_session=not-a-real-session" });
      const body = await jsonBody(res);
      expect(body.authenticated).toBe(false);
    });
  });

  describe("refresh", () => {
    it("requires a session (401) and rotates a valid one", async () => {
      const noSession = await api("POST", "/api/auth/refresh");
      expect(noSession.status).toBe(401);

      const cookie = await demoSessionToken();
      const res = await api("POST", "/api/auth/refresh", { cookie });
      expect(res.status).toBe(200);
      const newToken = parseSetCookie(res);
      expect(newToken).toBeTruthy();
      expect(newToken).not.toBe(cookie);

      // old token is revoked, new token works
      const oldSession = await api("GET", "/api/auth/session", { cookie });
      expect((await jsonBody(oldSession)).authenticated).toBe(false);
      const newSession = await api("GET", "/api/auth/session", { cookie: `lbtv_session=${newToken}` });
      expect((await jsonBody(newSession)).authenticated).toBe(true);
    });
  });

  describe("logout", () => {
    it("clears the cookie and revokes the session even without a cookie", async () => {
      const res = await api("POST", "/api/auth/logout");
      expect(res.status).toBe(200);
      expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");

      const cookie = await demoSessionToken();
      const out = await api("POST", "/api/auth/logout", { cookie });
      expect(out.headers.get("Set-Cookie")).toContain("Max-Age=0");
      const after = await api("GET", "/api/auth/session", { cookie });
      expect((await jsonBody(after)).authenticated).toBe(false);
    });
  });

  describe("register", () => {
    it("creates a user, signs them in, and blocks duplicates", async () => {
      const res = await api("POST", "/api/auth/register", {
        body: { email: "new@libre.tv", password: "longenoughpassword", display_name: "New User" },
      });
      expect(res.status).toBe(201);
      expect(res.headers.get("Set-Cookie")).toContain("lbtv_session=");

      const dup = await api("POST", "/api/auth/register", {
        body: { email: "NEW@libre.tv", password: "longenoughpassword" },
      });
      expect(dup.status).toBe(400);
      expect((await jsonBody(dup)).error.message).toBe("email already registered");

      // newly registered user can log in
      const login = await api("POST", "/api/auth/login", { body: { email: "new@libre.tv", password: "longenoughpassword" } });
      expect(login.status).toBe(200);
    });

    it("rejects short passwords with 400", async () => {
      const res = await api("POST", "/api/auth/register", { body: { email: "short@libre.tv", password: "short" } });
      expect(res.status).toBe(400);
    });
  });
});