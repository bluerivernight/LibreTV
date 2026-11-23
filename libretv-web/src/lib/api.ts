// Libre — thin API client for the Worker API (api.libre.tv).
// Covers auth (login/session/logout), catalog (list/detail), search and
// playback URLs. All requests carry the session cookie (`credentials: "include"`).

import type {
  ApiErrorEnvelope,
  BookmarkItem,
  LiveChannel,
  MediaDetail,
  MediaListItem,
  PartyCreatePayload,
  PartyInfoPayload,
  PersonDetail,
  ResolvePayload,
  SearchPayload,
  SessionPayload,
  SessionUser,
  SubtitlesPayload,
} from "../../../shared/api";

// VITE_API_URL carries the Worker origin in local dev (http://localhost:8787);
// VITE_API_BASE stays as a same-origin fallback for production deploys.
const apiOrigin = import.meta.env.VITE_API_URL;
export const API_BASE: string = apiOrigin ? `${apiOrigin}/api/v1` : (import.meta.env.VITE_API_BASE ?? "/api/v1");

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

interface ErrorBody {
  error: { code: string; message: string };
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: "include",
  });
  if (!res.ok) {
    let code = "unknown";
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as Partial<ApiErrorEnvelope> | ErrorBody;
      if (body.error) {
        code = body.error.code;
        message = body.error.message;
      }
    } catch {
      // Non-JSON error body — keep the generic message.
    }
    throw new ApiError(res.status, code, message);
  }
  return (await res.json()) as T;
}

export interface LoginPayload {
  authenticated: boolean;
  user: SessionUser | null;
}

export async function login(email: string, password: string): Promise<LoginPayload> {
  return requestJson<LoginPayload>("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
}

export function getSession(signal?: AbortSignal): Promise<SessionPayload> {
  return requestJson<SessionPayload>("/auth/session", { signal });
}

export async function logout(): Promise<void> {
  await requestJson<unknown>("/auth/logout", { method: "POST" });
}

export interface RegisterPayload {
  authenticated: boolean;
  user: SessionUser | null;
}

export async function register(
  email: string,
  password: string,
  displayName?: string | null,
): Promise<RegisterPayload> {
  return requestJson<RegisterPayload>("/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, display_name: displayName ?? null }),
  });
}

export function listMedia(signal?: AbortSignal): Promise<MediaListItem[]> {
  return requestJson<MediaListItem[]>("/media", { signal });
}

export async function listBookmarks(signal?: AbortSignal): Promise<BookmarkItem[]> {
  const payload = await requestJson<{ bookmarks: BookmarkItem[] }>("/bookmarks", {
    signal,
  });
  return payload.bookmarks;
}

export async function addBookmark(episodeId: string): Promise<void> {
  await requestJson<unknown>("/bookmarks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ episode_id: episodeId }),
  });
}

export async function removeBookmark(episodeId: string): Promise<void> {
  await requestJson<unknown>(`/bookmarks/${encodeURIComponent(episodeId)}`, {
    method: "DELETE",
  });
}

export function searchMedias(query: string, signal?: AbortSignal): Promise<SearchPayload> {  const qs = new URLSearchParams({ q: query }).toString();
  return requestJson<SearchPayload>(`/search?${qs}`, { signal });
}

export function getMediaDetail(id: string, signal?: AbortSignal): Promise<MediaDetail> {
  return requestJson<MediaDetail>(`/media/${encodeURIComponent(id)}`, { signal });
}

export function listLive(signal?: AbortSignal): Promise<LiveChannel[]> {
  return requestJson<LiveChannel[]>("/live", { signal });
}

export function getPersonDetail(id: string, signal?: AbortSignal): Promise<PersonDetail> {
  return requestJson<PersonDetail>(`/people/${encodeURIComponent(id)}`, { signal });
}

export function resolveWatch(kind: string, id: string, signal?: AbortSignal): Promise<ResolvePayload> {
  return requestJson<ResolvePayload>(
    `/resolve/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`,
    { signal },
  );
}

/** URL of the HLS master playlist the player should load for an asset. */
export function playbackUrl(assetId: string): string {
  return `${API_BASE}/playback/${encodeURIComponent(assetId)}`;
}

export async function listSubtitles(episodeId: string, signal?: AbortSignal): Promise<SubtitlesPayload> {
  return requestJson<SubtitlesPayload>(`/subtitles/${encodeURIComponent(episodeId)}`, {
    signal,
  });
}

/** URL of a served subtitle file (WebVTT). Session cookie required. */
export function subtitleFileUrl(subtitleId: string): string {
  return `${API_BASE}/subtitles/file/${encodeURIComponent(subtitleId)}`;
}

export async function createParty(episodeId: string, roomName?: string): Promise<PartyCreatePayload> {
  return requestJson<PartyCreatePayload>("/parties", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ episode_id: episodeId, room_name: roomName ?? null }),
  });
}

export function getPartyInfo(code: string, signal?: AbortSignal): Promise<PartyInfoPayload> {
  return requestJson<PartyInfoPayload>(`/parties/${encodeURIComponent(code.trim().toUpperCase())}`, {
    signal,
  });
}

/** Single-use 60s socket ticket (works where cookies don't travel). */
export async function getPartyTicket(code: string): Promise<string> {
  const payload = await requestJson<{ ticket: string }>(
    `/parties/${encodeURIComponent(code.trim().toUpperCase())}/ticket`,
    { method: "POST" },
  );
  return payload.ticket;
}

/** WebSocket URL for a party room (cookies attach same-site; ?session= fallback). */
export function partySocketUrl(code: string): string {
  const http = new URL(API_BASE, window.location.origin);
  http.protocol = http.protocol === "https:" ? "wss:" : "ws:";
  return `${http.toString().replace(/\/$/, "")}/parties/${encodeURIComponent(code.trim().toUpperCase())}/socket`;
}