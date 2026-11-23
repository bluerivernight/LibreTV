import { describe, it, expect } from "vitest";
import { handleCorsPreflight, addCorsHeaders } from "../../src/util/cors";
import type { Env } from "../../src/env";

const ALLOWED = "https://libre.tv";
const ALLOWED_JSON = "https://libre.tv, http://localhost:5173";

function testEnv(allowed: string): Env {
  return { ALLOWED_ORIGINS: allowed } as unknown as Env;
}

const ORIGIN = "https://libre.tv";

describe("CORS (§14)", () => {
  it("preflight: allowed origin → 204 with cached allow headers", () => {
    const res = handleCorsPreflight(new Request(`http://api.libre.tv/api/health`, { method: "OPTIONS", headers: { Origin: ORIGIN } }), testEnv(ALLOWED_JSON));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(204);
    const h = new Headers(res!.headers);
    expect(h.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(h.get("Access-Control-Allow-Methods")).toContain("GET");
    expect(h.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(h.get("Access-Control-Allow-Headers")).toBe("Range, Content-Type");
    expect(h.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(h.get("Access-Control-Max-Age")).toBe("3600");
  });

  it("preflight: unknown origin → 403; missing origin → 403", () => {
    const disallowed = handleCorsPreflight(new Request("http://api.libre.tv/api/health", { method: "OPTIONS", headers: { Origin: "https://evil.example" } }), testEnv(ALLOWED_JSON));
    const missing = handleCorsPreflight(new Request("http://api.libre.tv/api/health", { method: "OPTIONS" }), testEnv(ALLOWED_JSON));
    expect(disallowed?.status).toBe(403);
    expect(missing?.status).toBe(403);
  });

  it("preflight: GET is not a preflight", () => {
    const res = handleCorsPreflight(new Request(`http://api.libre.tv/api/health`, { headers: { Origin: ORIGIN } }), testEnv(ALLOWED_JSON));
    expect(res).toBeNull();
  });

  it("addCorsHeaders reflects the allowed origin and exposes byte-range headers", () => {
    const base = new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    const res = addCorsHeaders(new Request(`http://api.libre.tv/api/health`, { headers: { Origin: ORIGIN } }), base, testEnv(ALLOWED_JSON));
    const h = new Headers(res.headers);
    expect(h.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(h.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(h.get("Access-Control-Expose-Headers")).toContain("Content-Range");
  });

  it("addCorsHeaders leaves responses untouched for missing or disallowed origins", () => {
    const env = testEnv(ALLOWED_JSON);
    const noOrigin = addCorsHeaders(new Request("http://api.libre.tv/api/health"), new Response("{}"), env);
    const evil = addCorsHeaders(new Request(`http://api.libre.tv/api/health`, { headers: { Origin: "https://evil.example" } }), new Response("{}"), env);
    expect(noOrigin.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(new Headers(evil.headers).get("Access-Control-Allow-Origin")).toBeNull();
  });
});