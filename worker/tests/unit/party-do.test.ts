import { describe, it, expect, beforeAll } from "vitest";
import { env as testEnv } from "cloudflare:test";
import { seedDatabase, demoSessionToken } from "../helpers";
import {
  PartyRoom,
  handlePartyCreate,
  handlePartyInfo,
  ROOM_TTL_MS,
} from "../../src/routes/party";
import type { Env } from "../../src/env";

interface MockSocket {
  sent: string[];
  closed: number | null;
  attachment: { userId: string; name: string } | null;
  send(m: string): void;
  close(code?: number): void;
  serializeAttachment(a: { userId: string; name: string }): void;
  deserializeAttachment(): { userId: string; name: string } | null;
}

function mockSocket(attachment: MockSocket["attachment"] = null): MockSocket {
  return {
    sent: [],
    closed: null,
    attachment,
    send(m: string) {
      this.sent.push(m);
    },
    close(code = 1000) {
      this.closed = code;
    },
    serializeAttachment(a) {
      this.attachment = a;
    },
    deserializeAttachment() {
      return this.attachment;
    },
  };
}

function mockEnv(): Env {
  return { DB: testEnv.DB } as unknown as Env;
}

function mockState() {
  const store = new Map<string, unknown>();
  const sockets = new Set<MockSocket>();
  const state = {
    storage: {
      get: async (k: string) => store.get(k),
      put: async (k: string, v: unknown) => {
        store.set(k, v);
      },
      deleteAll: async () => {
        store.clear();
      },
    },
    acceptWebSocket: (ws: MockSocket) => {
      sockets.add(ws as never);
    },
    getWebSockets: () => [...sockets] as unknown as WebSocket[],
  };
  return { state, store, sockets };
}

async function authedRoom() {
  const cookie = await demoSessionToken();
  const token = cookie.split("=")[1]!;
  return { cookie, token };
}

describe("PartyRoom Durable Object", () => {
  beforeAll(async () => {
    await seedDatabase();
  });

  it("init → info round-trips; unknown → 404; expired → 410", async () => {
    const { state, store } = mockState();
    const door = new PartyRoom(state as never, mockEnv());
    const init = await door.fetch(
      new Request("https://party/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: "ABCDEFGH",
          hostUserId: "usr_demo",
          hostName: "Demo",
          episodeId: "ep_bbb_01",
          roomName: "Friday",
        }),
      }),
    );
    expect(init.status).toBe(200);

    const info = await door.fetch(new Request("https://party/info"));
    expect(info.status).toBe(200);
    const body = (await info.json()) as { code: string; member_count: number; active: boolean };
    expect(body.code).toBe("ABCDEFGH");
    expect(body.member_count).toBe(0);
    expect(body.active).toBe(true);

    const fresh = new PartyRoom(mockState().state as never, mockEnv());
    expect((await fresh.fetch(new Request("https://party/info"))).status).toBe(404);

    await store.set("room", {
      code: "ABCDEFGH",
      hostUserId: "usr_demo",
      hostName: "Demo",
      episodeId: "ep_bbb_01",
      roomName: null,
      createdAt: Date.now() - ROOM_TTL_MS - 1000,
    });
    expect((await door.fetch(new Request("https://party/info"))).status).toBe(410);
  });

  it("hello → joined + roster; host state → sync broadcast; guest state rejected", async () => {
    const { state } = mockState();
    const door = new PartyRoom(state as never, mockEnv());
    await door.fetch(
      new Request("https://party/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: "ABCDEFGH",
          hostUserId: "usr_demo",
          hostName: "Demo",
          episodeId: "ep_bbb_01",
          roomName: null,
        }),
      }),
    );

    const host = mockSocket({ userId: "usr_demo", name: "Demo" });
    await door.webSocketMessage(host as never, JSON.stringify({ t: "hello" }));
    const joined = JSON.parse(host.sent[0]!) as { t: string; you: string; members: unknown[]; is_host: boolean };
    expect(joined.t).toBe("joined");
    expect(joined.you).toBe("usr_demo");
    expect(joined.members).toHaveLength(1);
    expect(joined.is_host).toBe(true);

    // A second (guest) socket observes broadcasts.
    const guestSock = mockSocket({ userId: "usr_guest", name: "Guest" });
    (state as unknown as { acceptWebSocket(ws: unknown): void }).acceptWebSocket?.(guestSock);
    // Accept through the DO path instead: push directly into the live set.
    const live = (door as unknown as { members: Map<string, { userId: string; name: string; lastSeen: number }> });
    live.members.set("usr_guest", { userId: "usr_guest", name: "Guest", lastSeen: Date.now() });

    await door.webSocketMessage(host as never, JSON.stringify({ t: "state", position: 12.5, playing: true }));
    const sync = guestSock.sent.map((s) => JSON.parse(s)).find((m) => m.t === "sync") as {
      position: number;
      playing: boolean;
    };
    expect(sync.position).toBe(12.5);
    expect(sync.playing).toBe(true);

    const guest = mockSocket({ userId: "usr_guest", name: "Guest" });
    await door.webSocketMessage(guest as never, JSON.stringify({ t: "state", position: 99, playing: true }));
    expect(guest.sent.map((s) => JSON.parse(s) as { t: string }).find((m) => m.t === "error")).toBeTruthy();

    await door.webSocketMessage(host as never, JSON.stringify({ t: "bye" }));
    expect(host.closed).toBe(1000);
  });

  it("socket upgrade requires a session; then joins", async () => {    const { state } = mockState();
    const door = new PartyRoom(state as never, mockEnv());
    await door.fetch(
      new Request("https://party/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: "ABCDEFGH",
          hostUserId: "usr_demo",
          hostName: "Demo",
          episodeId: "ep_bbb_01",
          roomName: null,
        }),
      }),
    );
    const anon = await door.fetch(
      new Request("https://party/socket", { headers: { Upgrade: "websocket" } }),
    );
    expect(anon.status).toBe(401);

    const { token } = await authedRoom();
    const authed = await door.fetch(
      new Request(`https://party/socket?session=${token}`, { headers: { Upgrade: "websocket" } }),
    );
    expect(authed.status).toBe(101);
    expect(authed.webSocket).toBeTruthy();
  });

  it("ticket is single-use: first WS joins, replay is rejected", async () => {
    const { state } = mockState();
    const door = new PartyRoom(state as never, mockEnv());
    await door.fetch(
      new Request("https://party/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: "ABCDEFGH",
          hostUserId: "usr_demo",
          hostName: "Demo",
          episodeId: "ep_bbb_01",
          roomName: null,
        }),
      }),
    );
    const minted = await door.fetch(
      new Request("https://party/ticket", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: "usr_demo", name: "Demo" }),
      }),
    );
    expect(minted.status).toBe(200);
    const { ticket } = (await minted.json()) as { ticket: string };
    expect(typeof ticket).toBe("string");

    const first = await door.fetch(
      new Request(`https://party/socket?ticket=${ticket}`, { headers: { Upgrade: "websocket" } }),
    );
    expect(first.status).toBe(101);

    const replay = await door.fetch(
      new Request(`https://party/socket?ticket=${ticket}`, { headers: { Upgrade: "websocket" } }),
    );
    expect(replay.status).toBe(401);

    const bad = await door.fetch(
      new Request("https://party/ticket", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(bad.status).toBe(400);
  });
});

describe("party HTTP handlers (fake namespace → live DO)", () => {
  beforeAll(async () => {
    await seedDatabase();
  });

  function nsFor(door: PartyRoom) {
    return {
      idFromName: (name: string) => name,
      get: (_id: string) => ({
        fetch: (req: Request) => door.fetch(req),
      }),
    };
  }

  function handlerEnv(door: PartyRoom): Env {
    return { DB: testEnv.DB, PARTY_ROOM: nsFor(door) } as unknown as Env;
  }

  it("create validates, enriches info, rejects strangers", async () => {
    const { state } = mockState();
    const door = new PartyRoom(state as never, mockEnv());
    const env = handlerEnv(door);
    const cookie = await demoSessionToken();
    const withCookie = (c: string) => ({ Cookie: `lbtv_session=${c.split("=")[1]}` });

    const anon = await handlePartyCreate(
      new Request("https://x/api/v1/parties", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ episode_id: "ep_bbb_01" }),
      }),
      env,
    );
    expect(anon.status).toBe(401);

    const bad = await handlePartyCreate(
      new Request("https://x/api/v1/parties", {
        method: "POST",
        headers: { "content-type": "application/json", ...withCookie(cookie) },
        body: JSON.stringify({ episode_id: "ep_nope" }),
      }),
      env,
    );
    expect(bad.status).toBe(404);

    const created = await handlePartyCreate(
      new Request("https://x/api/v1/parties", {
        method: "POST",
        headers: { "content-type": "application/json", ...withCookie(cookie) },
        body: JSON.stringify({ episode_id: "ep_bbb_01", room_name: "Friday night" }),
      }),
      env,
    );
    expect(created.status).toBe(201);
    const { code } = (await created.json()) as { code: string };

    const info = await handlePartyInfo(
      new Request(`https://x/api/v1/parties/${code}`, { headers: withCookie(cookie) }),
      env,
      undefined as never,
      { pathname: { groups: { code } } } as never,
    );
    expect(info.status).toBe(200);
    const detail = (await info.json()) as { episode_title: string; series_name: string };
    expect(detail.episode_title).toBe("Sintel Trailer");
    expect(detail.series_name).toBe("Big Buck Bunny");
  });
});
