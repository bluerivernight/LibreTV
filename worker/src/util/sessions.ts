// Libre — opaque session management (§7.1).
// §7.1: session ID = 32 random bytes, base64url. Server stores sha256(raw) hex in D1.
// Cookie: Secure, HttpOnly, SameSite=Lax, Domain env-driven, Max-Age ≈ 7 days (§7.1).
// §7.2: sessions are authoritative in D1; revocation is a DELETE or revoked_at set.

import type { Env } from "../env";

const SESSION_COOKIE = "lbtv_session";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // §7.1 ESTIMATE, tunable

function base64urlRandom(byteLen: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(byteLen));
  let bin = "";
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(s: string): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return hex(h);
}

/** Generate a fresh opaque session token and return [rawToken, tokenHash]. */
export async function generateSessionToken(): Promise<{ raw: string; hash: string }> {
  const raw = base64urlRandom(32);
  const hash = await sha256Hex(raw);
  return { raw, hash };
}

/** §7.1 — serialize session cookie with Secure/HttpOnly/SameSite=Lax attributes. */
export function sessionCookieSet(rawToken: string, ttlSeconds: number = SESSION_TTL_SECONDS): string {
  // §7.1: Domain is set by the Worker's `Set-Cookie` attribute; actual Domain depends on runtime origin.
  // In tests the cookie is an opaque string; the browser enforces the Domain attribute.
  // `Domain` is NOT included in the Cookie header — it is only in Set-Cookie.
  return `${SESSION_COOKIE}=${rawToken}; HttpOnly; Secure; SameSite=Lax; Max-Age=${ttlSeconds}; Path=/`;
}

export function sessionCookieDelete(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/`;
}

/** Parse the session raw token from the Cookie header (or return null). */
export function parseSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const m = cookieHeader.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  return m?.[1] ?? null;
}

/** Create session row in D1. Returns { raw, hash } for the caller to set cookie. */
export async function createSession(
  db: Env["DB"],
  userId: string,
  userAgent: string | null,
  ttlSeconds: number = SESSION_TTL_SECONDS,
): Promise<{ raw: string; cookie: string }> {
  const { raw, hash } = await generateSessionToken();
  const now = Math.floor(Date.now() / 1000);
  await db.prepare(
    "INSERT INTO sessions (id, user_id, created_at, expires_at, revoked_at, user_agent) VALUES (?, ?, ?, ?, NULL, ?)",
  ).bind(hash, userId, now, now + ttlSeconds, userAgent).run();
  return { raw, cookie: sessionCookieSet(raw, ttlSeconds) };
}

/** Look up session by token hash, returning user context or null. */
export async function lookupSession(
  db: Env["DB"],
  rawToken: string,
): Promise<{ userId: string; isActive: boolean } | null> {
  const hash = await sha256Hex(rawToken);
  const now = Math.floor(Date.now() / 1000);
  const row = await db.prepare(
    "SELECT s.expires_at, s.revoked_at, s.user_id, u.is_active FROM sessions s LEFT JOIN users u ON u.id = s.user_id WHERE s.id = ?1 LIMIT 1",
  ).bind(hash).first<{ expires_at: number; revoked_at: number | null; user_id: string; is_active: number }>();
  if (!row) return null;
  if (row.revoked_at != null || row.expires_at < now) return null;
  return { userId: row.user_id, isActive: row.is_active === 1 };
}

/** Revoke a single session (§7.1 revocation). */
export async function revokeSession(db: Env["DB"], rawToken: string): Promise<boolean> {
  const hash = await sha256Hex(rawToken);
  const now = Math.floor(Date.now() / 1000);
  const res = await db.prepare("UPDATE sessions SET revoked_at = ?1 WHERE id = ?2 AND revoked_at IS NULL").bind(now, hash).run();
  return res.meta?.changes !== undefined ? (res.meta.changes ?? 0) > 0 : false;
}

export { SESSION_COOKIE };