// Libre — watch parties (realtime synchronized rooms).
//
// Rooms live 24h, keyed by an 8-char code. State lives in the PartyRoom
// Durable Object (one instance per code); the Worker only authenticates and
// enriches. Sync model: the host's player is the source of truth — guests
// follow play/pause/seek with a 3s drift tolerance (client-side).
//
// HTTP:
//   POST /api/parties                 { episode_id, room_name? } → { code, ... } (auth)
//   GET  /api/parties/:code          room info + member count (auth)
//   GET  /api/parties/:code/socket   WebSocket upgrade (session via cookie or ?session=)
// /api/v1/parties/* aliases (top-level mandate)
//
// Socket protocol (JSON):
//   → { t: "hello" }                              join (auth from handshake)
//   → { t: "state", position, playing }           host broadcast
//   → { t: "bye" }                                leave
//   ← { t: "joined", you, members }               ack + roster
//   ← { t: "members", members }                   roster update
//   ← { t: "sync", position, playing, by, at }    host state broadcast
//   ← { t: "error", message }                     fatal for this socket

import type { Env } from "../env";
import { param } from "../router";
import { json, notFound, unauthorized, forbidden, serverError } from "../util/http";
import { parseSessionCookie, lookupSession } from "../util/sessions";

export const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
const MEMBER_TIMEOUT_MS = 30_000;

const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export interface RoomMember {
  userId: string;
  name: string;
  lastSeen: number;
}

export interface RoomState {
  position: number;
  playing: boolean;
  by: string;
  at: number;
}

export interface RoomData {
  code: string;
  hostUserId: string;
  hostName: string;
  episodeId: string;
  roomName: string | null;
  createdAt: number;
}

/** Random 8-char room code (unambiguous alphabet). */
export function makeRoomCode(random: () => number = Math.random): string {
  let code = "";
  for (let i = 0; i < 8; i++) code += CODE_CHARS[Math.floor(random() * CODE_CHARS.length)];
  return code;
}

/** True when the room is older than the 24h TTL. */
export function isRoomExpired(createdAt: number, now: number = Date.now()): boolean {
  return now - createdAt > ROOM_TTL_MS;
}

/** Drop members whose heartbeat is older than the timeout. */
export function pruneMembers(
  members: Map<string, RoomMember>,
  now: number = Date.now(),
): Map<string, RoomMember> {
  for (const [id, m] of members) {
    if (now - m.lastSeen > MEMBER_TIMEOUT_MS) members.delete(id);
  }
  return members;
}

interface SocketAttachment {
  userId: string;
  name: string;
}

interface SocketTicket {
  userId: string;
  name: string;
  exp: number;
}

function makeTicket(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export class PartyRoom implements DurableObject {
  private members = new Map<string, RoomMember>();
  private room: RoomData | null = null;
  private playback: RoomState = { position: 0, playing: false, by: "", at: 0 };
  private tickets = new Map<string, SocketTicket>();

  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {}

  private broadcast(message: unknown, except?: WebSocket): void {
    const text = JSON.stringify(message);
    for (const ws of this.state.getWebSockets()) {
      if (except !== undefined && ws === except) continue;
      try {
        ws.send(text);
      } catch {
        // Dead socket; pruned on next heartbeat pass.
      }
    }
  }

  private roster(): Array<{ userId: string; name: string }> {
    pruneMembers(this.members);
    return [...this.members.values()].map((m) => ({ userId: m.userId, name: m.name }));
  }

  private async publishRoster(): Promise<void> {
    this.broadcast({ t: "members", members: this.roster() });
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname.endsWith("/init")) {
      const body = (await req.json()) as Partial<RoomData>;
      if (!body.code || !body.hostUserId || !body.episodeId) {
        return json({ error: { code: "bad_request", message: "code, hostUserId, episodeId required" } }, 400);
      }
      this.room = {
        code: body.code,
        hostUserId: body.hostUserId,
        hostName: body.hostName ?? "Host",
        episodeId: body.episodeId,
        roomName: body.roomName ?? null,
        createdAt: Date.now(),
      };
      this.members.clear();
      this.playback = { position: 0, playing: false, by: body.hostUserId, at: Date.now() };
      await this.state.storage.put("room", this.room);
      return json({ ok: true, code: this.room.code });
    }

    if (req.method === "GET" && url.pathname.endsWith("/info")) {
      const room: RoomData | undefined = await this.state.storage.get("room");
      if (!room) return json({ error: { code: "not_found", message: "room not found" } }, 404);
      if (isRoomExpired(room.createdAt)) {
        await this.state.storage.deleteAll();
        return json({ error: { code: "gone", message: "room expired" } }, 410);
      }
      this.room = room;
      return json({
        code: room.code,
        room_name: room.roomName,
        episode_id: room.episodeId,
        host_name: room.hostName,
        active: true,
        member_count: pruneMembers(this.members).size,
        state: this.playback,
      });
    }

    if (url.pathname.endsWith("/socket")) {
      const upgrade = req.headers.get("Upgrade");
      if (upgrade !== "websocket") {
        return json({ error: { code: "bad_request", message: "websocket upgrade required" } }, 400);
      }
      const room: RoomData | undefined = await this.state.storage.get("room");
      if (!room) return json({ error: { code: "not_found", message: "room not found" } }, 404);
      if (isRoomExpired(room.createdAt)) {
        await this.state.storage.deleteAll();
        return json({ error: { code: "gone", message: "room expired" } }, 410);
      }
      this.room = room;

      // Identity for the socket, in order of preference:
      // 1. single-use ticket (?ticket=) — works cross-site where cookies don't;
      // 2. session cookie (same-site) or ?session= (non-browser clients).
      let identity: { userId: string; name: string } | null = null;
      const ticket = url.searchParams.get("ticket");
      if (ticket) {
        const saved = this.tickets.get(ticket);
        this.tickets.delete(ticket);
        if (saved && saved.exp > Date.now()) identity = { userId: saved.userId, name: saved.name };
      }
      if (!identity) {
        const token =
          parseSessionCookie(req.headers.get("Cookie")) ?? url.searchParams.get("session");
        if (token) {
          const info = await lookupSession(this.env.DB, token);
          if (info?.isActive) {
            const user = await this.env.DB.prepare(
              "SELECT id, email, display_name FROM users WHERE id = ?1 LIMIT 1",
            ).bind(info.userId).first<{ id: string; email: string; display_name: string | null }>();
            if (user) identity = { userId: user.id, name: user.display_name ?? user.email };
          }
        }
      }
      if (!identity) {
        return json({ error: { code: "no_session", message: "unauthenticated" } }, 401);
      }
      const attachment: SocketAttachment = {
        userId: identity.userId,
        name: identity.name,
      };
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
      server.serializeAttachment(attachment);
      this.state.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (req.method === "POST" && url.pathname.endsWith("/ticket")) {
      // Mint a single-use 60s socket ticket. The caller (worker) authenticated
      // the user over the session cookie already; body carries identity.
      let userId = "";
      let name = "Guest";
      try {
        const body = (await req.json()) as { userId?: unknown; name?: unknown };
        userId = String(body.userId ?? "");
        if (typeof body.name === "string" && body.name.trim()) name = body.name.trim().slice(0, 80);
      } catch {
        return json({ error: { code: "bad_request", message: "userId is required" } }, 400);
      }
      if (!userId) {
        return json({ error: { code: "bad_request", message: "userId is required" } }, 400);
      }
      const ticket = makeTicket();
      this.tickets.set(ticket, { userId, name, exp: Date.now() + 60_000 });
      return json({ ticket, expires_in: 60 });
    }

    return json({ error: { code: "not_found", message: "unknown party endpoint" } }, 404);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (!this.room) return;
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    if (!attachment) {
      try { ws.close(4401, "unauthenticated"); } catch { /* already closed */ }
      return;
    }
    let msg: { t?: unknown; position?: unknown; playing?: unknown };
    try {
      msg = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
    } catch {
      return;
    }

    if (msg.t === "hello") {
      this.members.set(`${attachment.userId}`, {
        userId: attachment.userId,
        name: attachment.name,
        lastSeen: Date.now(),
      });
      try {
        ws.send(JSON.stringify({ t: "joined", you: attachment.userId, members: this.roster(), state: this.playback, is_host: attachment.userId === this.room.hostUserId }));
      } catch { /* ignore */ }
      await this.publishRoster();
      return;
    }

    if (msg.t === "bye") {
      this.members.delete(`${attachment.userId}`);
      await this.publishRoster();
      try { ws.close(1000, "bye"); } catch { /* ignore */ }
      return;
    }

    if (msg.t === "state") {
      // Only the host drives playback.
      if (attachment.userId !== this.room.hostUserId) {
        try { ws.send(JSON.stringify({ t: "error", message: "only the host drives playback" })); } catch { /* ignore */ }
        return;
      }
      const position = typeof msg.position === "number" && Number.isFinite(msg.position) ? msg.position : 0;
      this.playback = { position: Math.max(0, position), playing: msg.playing === true, by: attachment.userId, at: Date.now() };
      this.members.set(`${attachment.userId}`, {
        userId: attachment.userId,
        name: attachment.name,
        lastSeen: Date.now(),
      });
      this.broadcast({ t: "sync", ...this.playback });
      return;
    }

    if (msg.t === "ping") {
      const existing = this.members.get(`${attachment.userId}`);
      if (existing) existing.lastSeen = Date.now();
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    if (attachment) {
      this.members.delete(`${attachment.userId}`);
      await this.publishRoster();
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    if (attachment) {
      this.members.delete(`${attachment.userId}`);
      await this.publishRoster();
    }
  }
}

async function requireUserId(req: Request, env: Env): Promise<string> {
  const token = parseSessionCookie(req.headers.get("Cookie"));
  if (!token) throw new Error("no_session");
  const info = await lookupSession(env.DB, token);
  if (!info?.isActive) throw new Error("no_session");
  return info.userId;
}

function partyStub(env: Env, code: string) {
  if (!env.PARTY_ROOM) throw new Error("no_binding");
  return env.PARTY_ROOM.get(env.PARTY_ROOM.idFromName(code.toUpperCase()));
}

export async function handlePartyCreate(req: Request, env: Env): Promise<Response> {
  try {
    if (!env.PARTY_ROOM) return json({ error: { code: "unavailable", message: "watch parties are not enabled" } }, 503);
    const userId = await requireUserId(req, env);
    let episodeId = "";
    let roomName: string | null = null;
    try {
      const body = (await req.json()) as { episode_id?: unknown; room_name?: unknown };
      episodeId = String(body.episode_id ?? "");
      roomName = typeof body.room_name === "string" && body.room_name.trim() ? body.room_name.trim().slice(0, 80) : null;
    } catch {
      return json({ error: { code: "bad_request", message: "episode_id is required" } }, 400);
    }
    if (!episodeId) {
      return json({ error: { code: "bad_request", message: "episode_id is required" } }, 400);
    }
    const episode = await env.DB.prepare(
      "SELECT id FROM episodes WHERE id = ?1 LIMIT 1",
    ).bind(episodeId).first<{ id: string }>();
    if (!episode) return notFound("episode not found");
    const user = await env.DB.prepare(
      "SELECT display_name, email FROM users WHERE id = ?1 LIMIT 1",
    ).bind(userId).first<{ display_name: string | null; email: string }>();

    const code = makeRoomCode();
    const stub = partyStub(env, code);
    const init = await stub.fetch(
      new Request("https://party/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code,
          hostUserId: userId,
          hostName: user?.display_name ?? user?.email ?? "Host",
          episodeId,
          roomName,
        }),
      }),
    );
    if (!init.ok) return serverError();
    return json({ code, episode_id: episodeId, room_name: roomName }, 201);
  } catch (err) {
    if ((err as Error).message === "no_session") return unauthorized();
    if ((err as Error).message === "no_binding") {
      return json({ error: { code: "unavailable", message: "watch parties are not enabled" } }, 503);
    }
    return serverError();
  }
}

export async function handlePartyInfo(
  req: Request, env: Env, _ctx: ExecutionContext, match: URLPatternResult,
): Promise<Response> {
  try {
    if (!env.PARTY_ROOM) return json({ error: { code: "unavailable", message: "watch parties are not enabled" } }, 503);
    await requireUserId(req, env);
    const code = param(match, "code").toUpperCase();
    const stub = partyStub(env, code);
    const res = await stub.fetch(new Request("https://party/info"));
    const body = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      const status = res.status === 410 ? 410 : 404;
      return json(body, status);
    }
    // Enrich with the episode title for display.
    const ep = await env.DB.prepare(
      "SELECT e.title AS episode_title, s.name AS series_name FROM episodes e JOIN seasons sn ON sn.id = e.season_id JOIN series s ON s.id = sn.series_id WHERE e.id = ?1 LIMIT 1",
    ).bind((body as { episode_id?: string }).episode_id ?? "").first<{
      episode_title: string; series_name: string;
    }>();
    return json({
      ...(body as object),
      episode_title: ep?.episode_title ?? null,
      series_name: ep?.series_name ?? null,
    });
  } catch (err) {
    if ((err as Error).message === "no_session") return unauthorized();
    if ((err as Error).message === "no_binding") {
      return json({ error: { code: "unavailable", message: "watch parties are not enabled" } }, 503);
    }
    return serverError();
  }
}

export async function handlePartySocket(
  req: Request, env: Env, _ctx: ExecutionContext, match: URLPatternResult,
): Promise<Response> {
  try {
    if (!env.PARTY_ROOM) return json({ error: { code: "unavailable", message: "watch parties are not enabled" } }, 503);
    if (req.headers.get("Upgrade") !== "websocket") {
      return json({ error: { code: "bad_request", message: "websocket upgrade required" } }, 400);
    }
    const code = param(match, "code").toUpperCase();
    const stub = partyStub(env, code);
    // Forward the caller's request (headers incl. Upgrade + Cookie) untouched.
    return await stub.fetch(req);
  } catch (err) {
    if ((err as Error).message === "no_binding") {
      return json({ error: { code: "unavailable", message: "watch parties are not enabled" } }, 503);
    }
    return serverError();
  }
}

export async function handlePartyTicket(
  req: Request, env: Env, _ctx: ExecutionContext, match: URLPatternResult,
): Promise<Response> {
  try {
    if (!env.PARTY_ROOM) return json({ error: { code: "unavailable", message: "watch parties are not enabled" } }, 503);
    const userId = await requireUserId(req, env);
    const user = await env.DB.prepare(
      "SELECT display_name, email FROM users WHERE id = ?1 LIMIT 1",
    ).bind(userId).first<{ display_name: string | null; email: string }>();
    if (!user) return unauthorized();
    const code = param(match, "code").toUpperCase();
    const stub = partyStub(env, code);
    const res = await stub.fetch(
      new Request("https://party/ticket", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId, name: user.display_name ?? user.email }),
      }),
    );
    const body = (await res.json()) as Record<string, unknown>;
    return json(body, res.status);
  } catch (err) {
    if ((err as Error).message === "no_session") return unauthorized();
    if ((err as Error).message === "no_binding") {
      return json({ error: { code: "unavailable", message: "watch parties are not enabled" } }, 503);
    }
    return serverError();
  }
}
