// Libre — Auth routes (§7).
// POST /api/auth/login   — credential exchange, session creation, cookie set
// POST /api/auth/logout  — session revocation, cookie clear
// GET  /api/auth/session — session lookup and hydration
// POST /api/auth/refresh — rotate session (optional, §7.2)
// POST /api/auth/register — create user (optional, MVP)
//
// §7.1: no JWT, no KV. All state in D1. Cookie: Secure, HttpOnly, SameSite=Lax.
// §18: AUTH_LIMITER applied to unauthenticated endpoints (login/register).

import type { Env } from "../env";
import { param } from "../router";
import { json, badRequest, unauthorized, forbidden, notFound, rateLimited } from "../util/http";
import { hashPassword, verifyPassword } from "../util/passwords";
import { createSession, lookupSession, revokeSession, parseSessionCookie, sessionCookieDelete } from "../util/sessions";

// -- helpers -------------------------------------------------------------------

function currentSession(req: Request): string | null {
  return parseSessionCookie(req.headers.get("Cookie"));
}

async function requireAuth(req: Request): Promise<string | null> {
  return currentSession(req);
}

async function rateLimit(env: Env, key: string): Promise<boolean> {
  const limiter = env.AUTH_LIMITER;
  if (!limiter) return true; // §18: absent binding = skip (test/local)
  const { success } = await limiter.limit({ key });
  return success;
}

// -- route handlers ------------------------------------------------------------

export async function handleLogin(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!(await rateLimit(env, `login:${new URL(req.url).hostname}`)))
    return rateLimited("too many login attempts; try again in 60 s");

  const body = (await req.json()) as Record<string, unknown>;
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  if (!email || !password) return badRequest("email and password are required");

  const user = await env.DB.prepare(
    "SELECT id, email, display_name, password_hash, is_active FROM users WHERE email = ?1 LIMIT 1",
  ).bind(email).first<{ id: string; email: string; display_name: string | null; password_hash: string; is_active: number }>();
  if (!user) return unauthorized("invalid credentials");
  if (user.is_active !== 1) return forbidden("account disabled");

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) return unauthorized("invalid credentials");

  const ua = req.headers.get("User-Agent");
  const { cookie } = await createSession(env.DB, user.id, ua);

  const res = json({ authenticated: true, user: { id: user.id, email: user.email, display_name: user.display_name } });
  const h = new Headers(res.headers);
  h.append("Set-Cookie", cookie);
  return new Response(res.body, { status: res.status, headers: h });
}

export async function handleLogout(req: Request, env: Env): Promise<Response> {
  const token = currentSession(req);
  if (token) await revokeSession(env.DB, token);
  const res = json({ authenticated: false });
  const h = new Headers(res.headers);
  h.append("Set-Cookie", sessionCookieDelete());
  return new Response(res.body, { status: res.status, headers: h });
}

export async function handleSession(req: Request, env: Env): Promise<Response> {
  const token = currentSession(req);
  if (!token) return json({ authenticated: false, user: null, expires_at: null });

  const info = await lookupSession(env.DB, token);
  if (!info) return json({ authenticated: false, user: null, expires_at: null });

  const user = await env.DB.prepare(
    "SELECT id, email, display_name, is_admin FROM users WHERE id = ?1 LIMIT 1",
  ).bind(info.userId).first<{ id: string; email: string; display_name: string | null; is_admin: number }>();
  if (!user) return json({ authenticated: false, user: null, expires_at: null });

  // Lookup session row for expires_at (lookupSession already verified it's not expired)
  const sess = await env.DB.prepare("SELECT expires_at FROM sessions WHERE id = ?1 LIMIT 1")
    .bind(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)).then(b => Array.from(new Uint8Array(b), x => x.toString(16).padStart(2, "0")).join("")))
    .first<{ expires_at: number }>();

  return json({
    authenticated: true,
    user: { id: user.id, email: user.email, display_name: user.display_name, is_admin: user.is_admin === 1 },
    expires_at: sess?.expires_at ?? null,
  });
}

export async function handleRefresh(req: Request, env: Env): Promise<Response> {
  const token = currentSession(req);
  if (!token) return unauthorized("no session to refresh");

  const info = await lookupSession(env.DB, token);
  if (!info) return unauthorized("session invalid or expired");

  // Revoke old, create new (§7.2 rotate)
  await revokeSession(env.DB, token);
  const ua = req.headers.get("User-Agent");
  const { cookie } = await createSession(env.DB, info.userId, ua);

  const res = json({ authenticated: true });
  const h = new Headers(res.headers);
  h.append("Set-Cookie", cookie);
  return new Response(res.body, { status: res.status, headers: h });
}

export async function handleRegister(req: Request, env: Env): Promise<Response> {
  if (!(await rateLimit(env, `register:${new URL(req.url).hostname}`)))
    return rateLimited("too many registration attempts; try again in 60 s");

  const body = (await req.json()) as Record<string, unknown>;
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  const displayName = String(body.display_name ?? "").trim() || null;

  if (!email || !password) return badRequest("email and password are required");
  if (password.length < 8) return badRequest("password must be at least 8 characters");

  const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?1 LIMIT 1").bind(email).first();
  if (existing) return badRequest("email already registered");

  const passwordHash = await hashPassword(password);
  const now = Math.floor(Date.now() / 1000);
  const id = crypto.randomUUID();

  await env.DB.prepare(
    "INSERT INTO users (id, email, password_hash, display_name, is_active, is_admin, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 0, ?, ?)",
  ).bind(id, email, passwordHash, displayName, now, now).run();

  const ua = req.headers.get("User-Agent");
  const { cookie } = await createSession(env.DB, id, ua);

  const res = json({ authenticated: true, user: { id, email, display_name: displayName } }, 201);
  const h = new Headers(res.headers);
  h.append("Set-Cookie", cookie);
  return new Response(res.body, { status: res.status, headers: h });
}