// Libre — per-user episode bookmarks (§8: bookmarks table).
//
// GET    /api/bookmarks            → bookmarked episodes (enriched, newest first)
// POST   /api/bookmarks           → { episode_id } → bookmark it (idempotent)
// DELETE /api/bookmarks/:id       → remove bookmark (idempotent)
// /api/v1/bookmarks/* aliases (top-level mandate)
//
// All endpoints require a session (user-scoped rows). Unknown episode → 404.

import type { Env } from "../env";
import { param } from "../router";
import { json, notFound, unauthorized, serverError } from "../util/http";
import { parseSessionCookie, lookupSession } from "../util/sessions";

async function requireUserId(req: Request, env: Env): Promise<string> {
  const token = parseSessionCookie(req.headers.get("Cookie"));
  if (!token) throw new Error("no_session");
  const info = await lookupSession(env.DB, token);
  if (!info?.isActive) throw new Error("no_session");
  return info.userId;
}

export async function handleBookmarksList(req: Request, env: Env): Promise<Response> {
  try {
    const userId = await requireUserId(req, env);
    const rows = await env.DB.prepare(
      `SELECT b.episode_id, e.title AS episode_title, e.release_date,
              s.id AS series_id, s.name AS series_name
       FROM bookmarks b
       JOIN episodes e ON e.id = b.episode_id
       JOIN seasons sn ON sn.id = e.season_id
       JOIN series s ON s.id = sn.series_id
       WHERE b.user_id = ?1
       ORDER BY b.created_at DESC`
    ).bind(userId).all<{
      episode_id: string; episode_title: string; release_date: string | null;
      series_id: string; series_name: string;
    }>();
    return json({ bookmarks: rows.results ?? [] });
  } catch (err) {
    if ((err as Error).message === "no_session") return unauthorized();
    return serverError();
  }
}

export async function handleBookmarkAdd(req: Request, env: Env): Promise<Response> {
  try {
    const userId = await requireUserId(req, env);
    let episodeId: string;
    try {
      const body = await req.json() as { episode_id?: unknown };
      episodeId = String(body.episode_id ?? "");
    } catch {
      return json({ error: { code: "bad_request", message: "episode_id is required" } }, 400);
    }
    if (!episodeId) {
      return json({ error: { code: "bad_request", message: "episode_id is required" } }, 400);
    }
    const episode = await env.DB.prepare(
      "SELECT id FROM episodes WHERE id = ?1 LIMIT 1"
    ).bind(episodeId).first<{ id: string }>();
    if (!episode) return notFound("episode not found");

    const now = Math.floor(Date.now() / 1000);
    const res = await env.DB.prepare(
      "INSERT OR IGNORE INTO bookmarks (id, user_id, episode_id, created_at) VALUES (?1, ?2, ?3, ?4)"
    ).bind(crypto.randomUUID(), userId, episodeId, now).run();
    const created = (res.meta?.changes ?? 0) > 0;
    return json({ bookmarked: true, episode_id: episodeId }, created ? 201 : 200);
  } catch (err) {
    if ((err as Error).message === "no_session") return unauthorized();
    return serverError();
  }
}

export async function handleBookmarkRemove(
  req: Request, env: Env, _ctx: ExecutionContext, match: URLPatternResult,
): Promise<Response> {
  try {
    const userId = await requireUserId(req, env);
    const episodeId = param(match, "id");
    await env.DB.prepare(
      "DELETE FROM bookmarks WHERE user_id = ?1 AND episode_id = ?2"
    ).bind(userId, episodeId).run();
    return json({ bookmarked: false, episode_id: episodeId });
  } catch (err) {
    if ((err as Error).message === "no_session") return unauthorized();
    return serverError();
  }
}
