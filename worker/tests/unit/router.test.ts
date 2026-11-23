import { describe, it, expect } from "vitest";
import { createRouter, param } from "../../src/router";

describe("router (§5 native fetch routing)", () => {
  it("routes matching paths to the handler with extracted params", async () => {
    const r = createRouter();
    r.route("GET", "/api/media/:id", async (_req, _env, _ctx, match) => {
      return new Response(JSON.stringify({ id: param(match, "id") }), { status: 200 });
    });
    const res = await r.handle(new Request("http://test.local/api/media/ast_123"), {}, undefined as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "ast_123" });
  });

  it("returns a 404 envelope when method or path does not match", async () => {
    const r = createRouter();
    r.route("GET", "/api/health", async () => new Response("ok"));
    const wrongMethod = await r.handle(new Request("http://test.local/api/health", { method: "POST" }), {}, undefined as never);
    const wrongPath = await r.handle(new Request("http://test.local/api/nope"), {}, undefined as never);
    expect(wrongMethod.status).toBe(404);
    expect(wrongPath.status).toBe(404);
    const body = (await wrongPath.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  it("wraps handler exceptions in a 500 JSON envelope", async () => {
    const r = createRouter();
    r.route("GET", "/api/boom", async () => {
      throw new Error("kaboom");
    });
    const res = await r.handle(new Request("http://test.local/api/boom"), {}, undefined as never);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("internal_error");
  });
});