// Libre — Playback authorization (§10/§12, Model B).
//
// GET /api/playback/:assetId            → master playlist (alias to master)
// GET /api/playback/master/:assetId     → master playlist, variant URIs rewritten
// GET /api/playback/media/:assetId?var=  → media playlist, segments presigned to R2
// /api/v1/playback/* aliases (top-level mandate)
//
// §10.1: Worker is the authorization boundary.
// §10.2: session → asset enabled → rights check → presigned temporary access.
// §12.2: master playlists served by Worker; media playlists rewritten with presigned segment URLs.
// §18: PLAYBACK_LIMITER applied (keyed by userId).

import type { Env } from "../env";
import { param, searchParam } from "../router";
import { json, notFound, unauthorized, forbidden, rateLimited, r2Error, serverError } from "../util/http";
import { parseSessionCookie } from "../util/sessions";
import { lookupSession } from "../util/sessions";
import { presignGet } from "../util/presign";

// -- helpers -------------------------------------------------------------------

const HLS_CONTENT_TYPE = "application/vnd.apple.mpegurl";

function notHlsComment(line: string): boolean {
  const t = line.trim();
  return t !== "" && !t.startsWith("#");
}

async function presignKey(env: Env, bucketKey: string, ttlSeconds: number): Promise<string> {
  const accountId = env.R2_ACCOUNT_ID;
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY ?? "";
  if (!accountId || !accessKeyId || !secretAccessKey) throw new Error("R2 credentials not configured");
  const { url } = await presignGet({ bucketKey, accountId, accessKeyId, secretAccessKey, method: "GET", ttlSeconds });
  return url;
}

function getPresignTtl(env: Env): number {
  const raw = parseInt(env.PLAYBACK_PRESIGN_TTL_SECONDS ?? "1800", 10);
  return Math.max(60, Math.min(Number.isFinite(raw) ? raw : 1800, 604_800));
}

/** Parent directory of a storage key (e.g. "media/bbb01/720p/playlist.m3u8" → "media/bbb01/720p"). */
function dirOf(storageKey: string): string {
  return storageKey.substring(0, storageKey.lastIndexOf("/"));
}

/**
 * Resolve the rendition playlist key for a media request.
 *
 * Two shapes are legal:
 *   1. the requested asset IS the rendition (asset.rendition === var) → its own storage_key;
 *   2. the requested asset is the master, and ?var= names a sibling rendition → derive
 *      `${dir-of-master}/${var}/playlist.m3u8` and require that a real, enabled asset row
 *      backs that key (no fabricated keys, no tampered var values).
 */
async function resolvePlaylistKey(
  db: Env["DB"],
  asset: { storage_key: string; rendition: string | null },
  rendition: string,
): Promise<string> {
  if (asset.rendition === rendition) return asset.storage_key;
  if (!/^[A-Za-z0-9_-]+$/.test(rendition)) throw new Error("not_found");
  const target = `${dirOf(asset.storage_key)}/${rendition}/playlist.m3u8`;
  const row = await db.prepare(
    `SELECT storage_key, is_enabled FROM assets WHERE storage_key = ?1 LIMIT 1`
  ).bind(target).first<{ storage_key: string; is_enabled: number }>();
  if (!row) throw new Error("not_found");
  if (row.is_enabled !== 1) throw new Error("disabled");
  return target;
}

async function resolveSession(req: Request, env: Env): Promise<{ userId: string } | null> {
  const token = parseSessionCookie(req.headers.get("Cookie"));
  if (!token) return null;
  const info = await lookupSession(env.DB, token);
  if (!info?.isActive) return null;
  return { userId: info.userId };
}

async function loadAsset(db: Env["DB"], assetId: string) {
  const asset = await db.prepare(
    `SELECT a.id, a.episode_id, a.storage_key, a.media_type, a.rendition, a.is_enabled
     FROM assets a WHERE a.id = ?1 LIMIT 1`
  ).bind(assetId).first<{
    id: string; episode_id: string; storage_key: string; media_type: string;
    rendition: string | null; is_enabled: number;
  }>();
  return asset;
}

export async function hasRight(db: Env["DB"], episodeId: string, userId: string | null): Promise<boolean> {
  const nowTs = Math.floor(Date.now() / 1000);
  const right = await db.prepare(
    `SELECT 1 FROM rights r
     WHERE r.episode_id = ?1 AND (r.user_id = ?2 OR r.user_id IS NULL)
       AND (r.expires_at IS NULL OR r.expires_at > ?3)
     LIMIT 1`
  ).bind(episodeId, userId ?? "__none__", nowTs).first();
  return !!right;
}

// -- master playlist rewrite ---------------------------------------------------
// §12.2: master contains variant URI lines pointing to rendition playlists.
// Rewrite those URIs to point at our Worker media endpoint (presigned at request time).

export function rewriteMaster(masterText: string, assetId: string, baseUrl: string, env: Env): string {
  const ttl = getPresignTtl(env);
  const lines: string[] = [];
  for (const line of masterText.split("\n")) {
    const trimmed = line.trim();
    // #EXT-X-STREAM-INF lines have no URI; the next non-tag line is the URI
    if (trimmed !== "" && !trimmed.startsWith("#")) {
      // URI line — rewrite to Worker media endpoint (presign later, URI is deterministic)
      const rendition = trimmed.split("/")[0] ?? "";
      const workerUrl = `${baseUrl}/api/playback/media/${assetId}?var=${encodeURIComponent(rendition)}`;
      lines.push(workerUrl);
    } else {
      lines.push(line);
    }
  }
  return lines.join("\n");
}

// -- media playlist rewrite ----------------------------------------------------
// §12.2: replace segment URI lines with presigned absolute R2 URLs.
// Fallback (no R2 credentials, e.g. local dev): Worker-relative segment URLs
// served by handleSegment below — still session- and rights-gated.

export function segmentUrl(baseUrl: string, bucketKey: string): string {
  const b64 = btoa(bucketKey).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${baseUrl}/api/v1/segments/${b64}`;
}

export function decodeSegmentKey(encoded: string): string | null {
  try {
    let b = encoded.replace(/-/g, "+").replace(/_/g, "/");
    while (b.length % 4) b += "=";
    const key = atob(b);
    if (!key || key.includes("..")) return null;
    return key;
  } catch {
    return null;
  }
}

export async function rewriteMedia(
  text: string,
  storageKey: string,
  env: Env,
  baseUrl: string,
): Promise<string> {
  const ttl = getPresignTtl(env);
  // Derive segment directory from the storage_key (e.g. "media/bbb01/720p/playlist.m3u8" → "media/bbb01/720p")
  const dir = storageKey.substring(0, storageKey.lastIndexOf("/"));
  const lines: string[] = [];

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed !== "" && !trimmed.startsWith("#")) {
      // Segment URI line — presign as R2 object (siblings of the playlist)
      const segmentKey = `${dir}/${trimmed}`;
      try {
        const signed = await presignKey(env, segmentKey, ttl);
        lines.push(signed);
      } catch (err) {
        lines.push(segmentUrl(baseUrl, segmentKey));
      }
    } else {
      lines.push(line);
    }
  }
  return lines.join("\n");
}

// -- handler entry points ------------------------------------------------------

async function authorizePlayback(req: Request, env: Env, assetId: string) {
  // §18: rate limit
  const limiter = env.PLAYBACK_LIMITER;
  if (limiter) {
    const { success } = await limiter.limit({ key: `play:${assetId}` });
    if (!success) throw new Error("rate_limited");
  }

  const session = await resolveSession(req, env);
  if (!session) throw new Error("no_session");

  const asset = await loadAsset(env.DB, assetId);
  if (!asset) throw new Error("not_found");
  if (asset.is_enabled !== 1) throw new Error("disabled");

  const right = await hasRight(env.DB, asset.episode_id, session.userId);
  if (!right) throw new Error("no_rights");

  return asset;
}

export async function handlePlaybackMaster(req: Request, env: Env, _ctx: ExecutionContext, match: URLPatternResult): Promise<Response> {
  const assetId = param(match, "id");
  try {
    const asset = await authorizePlayback(req, env, assetId);
    const object = await env.MEDIA_BUCKET.get(asset.storage_key);
    if (!object) return r2Error(new Error("NoSuchKey: master playlist not found"));

    const text = await object.text();
    const baseUrl = new URL(req.url).origin;
    const rewritten = rewriteMaster(text, assetId, baseUrl, env);

    return new Response(rewritten, {
      status: 200,
      headers: { "content-type": HLS_CONTENT_TYPE, "cache-control": "no-store" },
    });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg === "no_session") return unauthorized();
    if (msg === "not_found") return notFound("asset not found");
    if (msg === "disabled") return forbidden("asset disabled");
    if (msg === "no_rights") return forbidden("no playback rights for this session");
    if (msg === "rate_limited") return rateLimited();
    return r2Error(err);
  }
}

// -- raw segments (dev/no-R2 fallback) ---------------------------------------
// GET /api/segments/:key → R2 object bytes. The key is base64url of the bucket
// key; the episode is resolved through the sibling playlist asset row, then
// the same session + rights gate as media playlists applies. Supports Range.
export async function handleSegment(req: Request, env: Env, _ctx: ExecutionContext, match: URLPatternResult): Promise<Response> {
  try {
    const bucketKey = decodeSegmentKey(param(match, "id"));
    if (!bucketKey) return notFound("bad segment key");
    const parts = bucketKey.split("/");
    if (parts.length < 2) return notFound("bad segment key");
    const playlistKey = `${parts.slice(0, -1).join("/")}/playlist.m3u8`;
    const asset = await env.DB.prepare(
      "SELECT episode_id, is_enabled FROM assets WHERE storage_key = ?1 LIMIT 1"
    ).bind(playlistKey).first<{ episode_id: string; is_enabled: number }>();
    if (!asset) return notFound("segment not found");
    if (asset.is_enabled !== 1) return forbidden("asset disabled");

    const session = await resolveSession(req, env);
    if (!session) return unauthorized();
    if (!(await hasRight(env.DB, asset.episode_id, session.userId))) {
      return forbidden("no playback rights for this session");
    }

    const object = await env.MEDIA_BUCKET.get(bucketKey);
    if (!object) return notFound("segment not found");
    const data = await object.arrayBuffer();
    const headers: Record<string, string> = {
      "content-type": "video/mp2t",
      "accept-ranges": "bytes",
      "cache-control": "private, max-age=3600",
    };

    const range = req.headers.get("Range");
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (m) {
        const first = m[1] ?? "";
        const last = m[2] ?? "";
        const suffixLen = first === "" ? parseInt(last || "0", 10) || 0 : 0;
        const start = first === "" ? Math.max(0, data.byteLength - suffixLen) : parseInt(first, 10);
        const end = first === "" || last === "" ? data.byteLength - 1 : parseInt(last, 10);
        if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end >= start && end < data.byteLength) {
          headers["content-range"] = `bytes ${start}-${end}/${data.byteLength}`;
          headers["content-length"] = String(end - start + 1);
          return new Response(data.slice(start, end + 1), { status: 206, headers });
        }
      }
    }
    headers["content-length"] = String(data.byteLength);
    return new Response(data, { status: 200, headers });
  } catch {
    return serverError();
  }
}

export async function handlePlaybackMedia(req: Request, env: Env, _ctx: ExecutionContext, match: URLPatternResult): Promise<Response> {
  const assetId = param(match, "id");
  const rendition = searchParam(req, "var");
  if (!rendition) return json({ error: { code: "bad_request", message: "var query parameter is required" } }, 400);

  try {
    const asset = await authorizePlayback(req, env, assetId);

    // Resolve the rendition playlist: direct rendition asset request, or master asset + ?var=
    const playlistKey = await resolvePlaylistKey(env.DB, asset, rendition);
    const object = await env.MEDIA_BUCKET.get(playlistKey);
    if (!object) return r2Error(new Error("NoSuchKey: rendition playlist not found"));

    const text = await object.text();
    const rewritten = await rewriteMedia(text, playlistKey, env, new URL(req.url).origin);

    return new Response(rewritten, {
      status: 200,
      headers: { "content-type": HLS_CONTENT_TYPE, "cache-control": "no-store" },
    });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg === "no_session") return unauthorized();
    if (msg === "not_found") return notFound("asset not found");
    if (msg === "disabled") return forbidden("asset disabled");
    if (msg === "no_rights") return forbidden("no playback rights for this session");
    if (msg === "rate_limited") return rateLimited();
    return r2Error(err);
  }
}