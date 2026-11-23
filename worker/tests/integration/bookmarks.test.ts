import { describe, it, expect, beforeAll } from "vitest";
import { seedDatabase, api, demoSessionToken } from "../helpers";

beforeAll(async () => {
  await seedDatabase();
});

describe("bookmarks (§8)", () => {
  it("requires a session for list/add/remove", async () => {
    const list = await api("GET", "/api/v1/bookmarks");
    expect(list.status).toBe(401);
    const add = await api("POST", "/api/v1/bookmarks", {
      body: { episode_id: "ep_bbb_01" },
    });
    expect(add.status).toBe(401);
    const del = await api("DELETE", "/api/v1/bookmarks/ep_bbb_01");
    expect(del.status).toBe(401);
  });

  it("CRUD: empty → add (201) → listed → re-add idempotent (200) → remove", async () => {
    const cookie = await demoSessionToken();

    const empty = await api("GET", "/api/v1/bookmarks", { cookie });
    expect(empty.status).toBe(200);
    expect((await empty.json()) as unknown).toEqual({ bookmarks: [] });

    const add = await api("POST", "/api/v1/bookmarks", {
      cookie,
      body: { episode_id: "ep_bbb_01" },
    });
    expect(add.status).toBe(201);

    const listed = (await (
      await api("GET", "/api/v1/bookmarks", { cookie })
    ).json()) as {
      bookmarks: Array<{ episode_id: string; episode_title: string; series_name: string }>;
    };
    expect(listed.bookmarks).toHaveLength(1);
    expect(listed.bookmarks[0]!.episode_id).toBe("ep_bbb_01");
    expect(listed.bookmarks[0]!.episode_title).toBe("Sintel Trailer");
    expect(listed.bookmarks[0]!.series_name).toBe("Big Buck Bunny");

    const again = await api("POST", "/api/v1/bookmarks", {
      cookie,
      body: { episode_id: "ep_bbb_01" },
    });
    expect(again.status).toBe(200);

    const del = await api("DELETE", "/api/v1/bookmarks/ep_bbb_01", { cookie });
    expect(del.status).toBe(200);

    const gone = (await (
      await api("GET", "/api/v1/bookmarks", { cookie })
    ).json()) as { bookmarks: unknown[] };
    expect(gone.bookmarks).toEqual([]);
  });

  it("add rejects unknown episodes (404) and missing ids (400)", async () => {
    const cookie = await demoSessionToken();
    const missing = await api("POST", "/api/v1/bookmarks", {
      cookie,
      body: { episode_id: "ep_nope" },
    });
    expect(missing.status).toBe(404);
    const empty = await api("POST", "/api/v1/bookmarks", { cookie, body: {} });
    expect(empty.status).toBe(400);
  });

  it("bookmarks are per-user (register sees an empty list)", async () => {
    const demoCookie = await demoSessionToken();
    await api("POST", "/api/v1/bookmarks", {
      cookie: demoCookie,
      body: { episode_id: "ep_bbb_01" },
    });
    const reg = await api("POST", "/api/v1/auth/register", {
      body: { email: "bm@example.com", password: "bm-pass-99", display_name: "Bm" },
    });
    expect(reg.status).toBe(201);
    const setCookie = reg.headers.get("Set-Cookie") ?? "";
    const token = /lbtv_session=([^;]+)/.exec(setCookie)?.[1];
    expect(token).toBeTruthy();
    const other = (await (
      await api("GET", "/api/v1/bookmarks", { cookie: `lbtv_session=${token}` })
    ).json()) as { bookmarks: unknown[] };
    expect(other.bookmarks).toEqual([]);
    await api("DELETE", "/api/v1/bookmarks/ep_bbb_01", { cookie: demoCookie });
  });
});
