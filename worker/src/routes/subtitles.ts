// Libre — subtitle serving (§8: subtitles table).
//
// GET /api/subtitles/:episodeId        → [{ id, language, is_default }]
// GET /api/subtitles/file/:subtitleId → WebVTT body (SRT converted on the fly)
// /api/v1/subtitles/* aliases (top-level mandate)
//
// Listing is public (language names only). File bodies require a session with
// playback rights for the episode — same gate as media playlists.

import type { Env } from "../env";
import { param } from "../router";
import { json, notFound, unauthorized, forbidden, serverError } from "../util/http";
import { parseSessionCookie, lookupSession } from "../util/sessions";
import { hasRight } from "./playback";

async function resolveUserId(req: Request, env: Env): Promise<string | null> {
  const token = parseSessionCookie(req.headers.get("Cookie"));
  if (!token) return null;
  const info = await lookupSession(env.DB, token);
  return info?.isActive ? info.userId : null;
}

/** Minimal SRT → WebVTT: header + comma-to-dot millisecond separators. */
export function srtToVtt(srt: string): string {
  const body = srt
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(
      /(\d{2}:\d{2}:\d{2}),(\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}),(\d{3})/g,
      "$1.$2 --> $3.$4",
    );
  return body.startsWith("WEBVTT") ? body : `WEBVTT\n\n${body}`;
}

export async function handleSubtitlesList(
  req: Request, env: Env, _ctx: ExecutionContext, match: URLPatternResult,
): Promise<Response> {
  try {
    const episodeId = param(match, "id");
    const rows = await env.DB.prepare(
      `SELECT id, language, is_default FROM subtitles
       WHERE episode_id = ?1 ORDER BY is_default DESC, language ASC`
    ).bind(episodeId).all<{ id: string; language: string; is_default: number }>();
    return json({
      episode_id: episodeId,
      subtitles: (rows.results ?? []).map((r) => ({
        id: r.id,
        language: r.language,
        is_default: r.is_default === 1,
      })),
    });
  } catch {
    return serverError();
  }
}

export async function handleSubtitleFile(
  req: Request, env: Env, _ctx: ExecutionContext, match: URLPatternResult,
): Promise<Response> {
  try {
    const subtitleId = param(match, "id");
    const row = await env.DB.prepare(
      "SELECT id, episode_id, language, storage_key FROM subtitles WHERE id = ?1 LIMIT 1"
    ).bind(subtitleId).first<{
      id: string; episode_id: string; language: string; storage_key: string;
    }>();
    if (!row) return notFound("subtitle not found");

    const userId = await resolveUserId(req, env);
    if (!userId) return unauthorized();
    if (!(await hasRight(env.DB, row.episode_id, userId))) {
      return forbidden("no playback rights for this session");
    }

    const object = await env.MEDIA_BUCKET.get(row.storage_key);
    if (!object) return notFound("subtitle file not found");
    const vtt = srtToVtt(await object.text());
    return new Response(vtt, {
      status: 200,
      headers: {
        "content-type": "text/vtt; charset=utf-8",
        "cache-control": "private, max-age=3600",
      },
    });
  } catch {
    return serverError();
  }
}
