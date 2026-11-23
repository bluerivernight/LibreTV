import { describe, it, expect, beforeAll } from "vitest";
import { seedDatabase, api } from "../helpers";

describe("health (§5 mandated endpoint)", () => {
  beforeAll(seedDatabase);

  it("GET /api/health → 200 ok with service name and integer timestamp", async () => {
    const res = await api("GET", "/api/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { status: string; service: string; ts: number };
    expect(body.status).toBe("ok");
    expect(body.service).toBe("libre-api");
    expect(Number.isInteger(body.ts)).toBe(true);
  });

  it("GET /api/v1/health (top-level mandate) → 200", async () => {
    const res = await api("GET", "/api/v1/health");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("ok");
  });

  it("unmapped route → 404 error envelope", async () => {
    const res = await api("GET", "/api/no-such-route");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  it("cors preflight on the allowed origin is served (204)", async () => {
    const res = await api("OPTIONS", "/api/health", { origin: "https://libre.tv" });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://libre.tv");
    expect(res.headers.get("Access-Control-Max-Age")).toBe("3600");
  });

  it("cors preflight from an unknown origin is rejected (403)", async () => {
    const res = await api("OPTIONS", "/api/health", { origin: "https://evil.example" });
    expect(res.status).toBe(403);
  });

  it("cors processing applies to error responses too", async () => {
    const res = await api("GET", "/api/no-such-route", { origin: "https://libre.tv" });
    expect(res.status).toBe(404);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://libre.tv");
  });
});