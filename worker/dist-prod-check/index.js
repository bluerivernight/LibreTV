var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/router.ts
function createRouter() {
  const routes = [];
  function route(method, path, handler) {
    routes.push({ method: method.toUpperCase(), pattern: new URLPattern({ pathname: path }), handler });
  }
  __name(route, "route");
  async function handle(req, env, ctx) {
    const url = new URL(req.url);
    const method = req.method.toUpperCase();
    for (const r of routes) {
      if (r.method !== method && r.method !== "*") continue;
      const match = r.pattern.exec(url.toString());
      if (match) {
        try {
          return await r.handler(req, env, ctx, match);
        } catch (err) {
          console.error(`[router] unhandled error in ${method} ${url.pathname}:`, err);
          return new Response(JSON.stringify({ error: { code: "internal_error", message: "unhandled route error" } }), {
            status: 500,
            headers: { "content-type": "application/json" }
          });
        }
      }
    }
    return new Response(JSON.stringify({ error: { code: "not_found", message: "route not found" } }), {
      status: 404,
      headers: { "content-type": "application/json" }
    });
  }
  __name(handle, "handle");
  return { route, handle };
}
__name(createRouter, "createRouter");
function param(match, name) {
  return match.pathname.groups[name] ?? "";
}
__name(param, "param");
function searchParam(req, name) {
  return new URL(req.url).searchParams.get(name);
}
__name(searchParam, "searchParam");

// src/util/cors.ts
function parseAllowedOrigins(env) {
  return (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
}
__name(parseAllowedOrigins, "parseAllowedOrigins");
function addCorsHeaders(req, res, env) {
  const origin = req.headers.get("Origin");
  if (!origin) return res;
  const allowed = parseAllowedOrigins(env);
  if (!allowed.includes(origin)) return res;
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", origin);
  h.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Range");
  h.set("Access-Control-Expose-Headers", "Content-Length, Content-Range, ETag, Accept-Ranges");
  h.set("Access-Control-Allow-Credentials", "true");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}
__name(addCorsHeaders, "addCorsHeaders");
function handleCorsPreflight(req, env) {
  if (req.method !== "OPTIONS") return null;
  const origin = req.headers.get("Origin");
  if (!origin) return new Response(null, { status: 403 });
  const allowed = parseAllowedOrigins(env);
  if (!allowed.includes(origin)) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "Range",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Max-Age": "3600"
    }
  });
}
__name(handleCorsPreflight, "handleCorsPreflight");

// src/util/http.ts
function json(body, status = 200, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}
__name(json, "json");
function apiError(code, message, status = 400) {
  return json({ error: { code, message } }, status);
}
__name(apiError, "apiError");
var notFound = /* @__PURE__ */ __name((msg = "not found") => apiError("not_found", msg, 404), "notFound");
var badRequest = /* @__PURE__ */ __name((msg = "bad request") => apiError("bad_request", msg, 400), "badRequest");
var unauthorized = /* @__PURE__ */ __name((msg = "unauthenticated") => apiError("no_session", msg, 401), "unauthorized");
var forbidden = /* @__PURE__ */ __name((msg = "forbidden") => apiError("no_rights", msg, 403), "forbidden");
var serverError = /* @__PURE__ */ __name((msg = "internal error") => apiError("internal_error", msg, 500), "serverError");
var rateLimited = /* @__PURE__ */ __name((msg = "rate limit exceeded") => apiError("rate_limited", msg, 429), "rateLimited");
function r2Error(err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("NoSuchKey")) return notFound("media not found");
  if (msg.includes("ExpiredRequest")) return apiError("expired_presign", "presigned URL expired; re-auth through Worker", 403);
  return serverError(`r2 error: ${msg}`);
}
__name(r2Error, "r2Error");

// src/routes/health.ts
async function handleHealth() {
  return json({ status: "ok", service: "libre-api", ts: Math.floor(Date.now() / 1e3) });
}
__name(handleHealth, "handleHealth");

// src/util/passwords.ts
var ALG = "PBKDF2";
var HASH = "SHA-256";
var ITERATIONS = 21e4;
var SALT_LEN = 16;
var DK_LEN = 32;
function base64url(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
__name(base64url, "base64url");
function base64urlToBytes(s) {
  let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
__name(base64urlToBytes, "base64urlToBytes");
function splitHash(stored) {
  const parts = stored.split("$");
  if (parts.length !== 5 || parts[0] !== "pbkdf2" || parts[1] !== "sha256") return null;
  const iterations = parseInt(parts[2], 10);
  if (!Number.isFinite(iterations) || iterations <= 0) return null;
  try {
    return { iterations, salt: base64urlToBytes(parts[3]), dk: base64urlToBytes(parts[4]) };
  } catch {
    return null;
  }
}
__name(splitHash, "splitHash");
async function hashPassword(plaintext) {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(plaintext), ALG, false, ["deriveBits"]);
  const dk = await crypto.subtle.deriveBits({ name: ALG, salt, iterations: ITERATIONS, hash: HASH }, keyMaterial, DK_LEN * 8);
  return `pbkdf2$sha256$${ITERATIONS}$${base64url(salt)}$${base64url(dk)}`;
}
__name(hashPassword, "hashPassword");
async function verifyPassword(plaintext, stored) {
  const parsed = splitHash(stored);
  if (!parsed) return false;
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(plaintext), ALG, false, ["deriveBits"]);
  const dk = await crypto.subtle.deriveBits(
    { name: ALG, salt: parsed.salt, iterations: parsed.iterations, hash: HASH },
    keyMaterial,
    parsed.dk.length * 8
  );
  const computed = new Uint8Array(dk);
  if (computed.length !== parsed.dk.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) diff |= (computed[i] ?? 0) ^ (parsed.dk[i] ?? 0);
  return diff === 0;
}
__name(verifyPassword, "verifyPassword");

// src/util/sessions.ts
var SESSION_COOKIE = "lbtv_session";
var SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
function base64urlRandom(byteLen) {
  const buf = crypto.getRandomValues(new Uint8Array(byteLen));
  let bin = "";
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
__name(base64urlRandom, "base64urlRandom");
function hex(buf) {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}
__name(hex, "hex");
async function sha256Hex(s) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return hex(h);
}
__name(sha256Hex, "sha256Hex");
async function generateSessionToken() {
  const raw = base64urlRandom(32);
  const hash = await sha256Hex(raw);
  return { raw, hash };
}
__name(generateSessionToken, "generateSessionToken");
function sessionCookieSet(rawToken, ttlSeconds = SESSION_TTL_SECONDS) {
  return `${SESSION_COOKIE}=${rawToken}; HttpOnly; Secure; SameSite=Lax; Max-Age=${ttlSeconds}; Path=/`;
}
__name(sessionCookieSet, "sessionCookieSet");
function sessionCookieDelete() {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/`;
}
__name(sessionCookieDelete, "sessionCookieDelete");
function parseSessionCookie(cookieHeader) {
  if (!cookieHeader) return null;
  const m = cookieHeader.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  return m?.[1] ?? null;
}
__name(parseSessionCookie, "parseSessionCookie");
async function createSession(db, userId, userAgent, ttlSeconds = SESSION_TTL_SECONDS) {
  const { raw, hash } = await generateSessionToken();
  const now = Math.floor(Date.now() / 1e3);
  await db.prepare(
    "INSERT INTO sessions (id, user_id, created_at, expires_at, revoked_at, user_agent) VALUES (?, ?, ?, ?, NULL, ?)"
  ).bind(hash, userId, now, now + ttlSeconds, userAgent).run();
  return { raw, cookie: sessionCookieSet(raw, ttlSeconds) };
}
__name(createSession, "createSession");
async function lookupSession(db, rawToken) {
  const hash = await sha256Hex(rawToken);
  const now = Math.floor(Date.now() / 1e3);
  const row = await db.prepare(
    "SELECT s.expires_at, s.revoked_at, s.user_id, u.is_active FROM sessions s LEFT JOIN users u ON u.id = s.user_id WHERE s.id = ?1 LIMIT 1"
  ).bind(hash).first();
  if (!row) return null;
  if (row.revoked_at != null || row.expires_at < now) return null;
  return { userId: row.user_id, isActive: row.is_active === 1 };
}
__name(lookupSession, "lookupSession");
async function revokeSession(db, rawToken) {
  const hash = await sha256Hex(rawToken);
  const now = Math.floor(Date.now() / 1e3);
  const res = await db.prepare("UPDATE sessions SET revoked_at = ?1 WHERE id = ?2 AND revoked_at IS NULL").bind(now, hash).run();
  return res.meta?.changes !== void 0 ? (res.meta.changes ?? 0) > 0 : false;
}
__name(revokeSession, "revokeSession");

// src/routes/auth.ts
function currentSession(req) {
  return parseSessionCookie(req.headers.get("Cookie"));
}
__name(currentSession, "currentSession");
async function rateLimit(env, key) {
  const limiter = env.AUTH_LIMITER;
  if (!limiter) return true;
  const { success } = await limiter.limit({ key });
  return success;
}
__name(rateLimit, "rateLimit");
async function handleLogin(req, env, ctx) {
  if (!await rateLimit(env, `login:${new URL(req.url).hostname}`))
    return rateLimited("too many login attempts; try again in 60 s");
  const body = await req.json();
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  if (!email || !password) return badRequest("email and password are required");
  const user = await env.DB.prepare(
    "SELECT id, email, display_name, password_hash, is_active FROM users WHERE email = ?1 LIMIT 1"
  ).bind(email).first();
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
__name(handleLogin, "handleLogin");
async function handleLogout(req, env) {
  const token = currentSession(req);
  if (token) await revokeSession(env.DB, token);
  const res = json({ authenticated: false });
  const h = new Headers(res.headers);
  h.append("Set-Cookie", sessionCookieDelete());
  return new Response(res.body, { status: res.status, headers: h });
}
__name(handleLogout, "handleLogout");
async function handleSession(req, env) {
  const token = currentSession(req);
  if (!token) return json({ authenticated: false, user: null, expires_at: null });
  const info = await lookupSession(env.DB, token);
  if (!info) return json({ authenticated: false, user: null, expires_at: null });
  const user = await env.DB.prepare(
    "SELECT id, email, display_name, is_admin FROM users WHERE id = ?1 LIMIT 1"
  ).bind(info.userId).first();
  if (!user) return json({ authenticated: false, user: null, expires_at: null });
  const sess = await env.DB.prepare("SELECT expires_at FROM sessions WHERE id = ?1 LIMIT 1").bind(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)).then((b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join(""))).first();
  return json({
    authenticated: true,
    user: { id: user.id, email: user.email, display_name: user.display_name, is_admin: user.is_admin === 1 },
    expires_at: sess?.expires_at ?? null
  });
}
__name(handleSession, "handleSession");
async function handleRefresh(req, env) {
  const token = currentSession(req);
  if (!token) return unauthorized("no session to refresh");
  const info = await lookupSession(env.DB, token);
  if (!info) return unauthorized("session invalid or expired");
  await revokeSession(env.DB, token);
  const ua = req.headers.get("User-Agent");
  const { cookie } = await createSession(env.DB, info.userId, ua);
  const res = json({ authenticated: true });
  const h = new Headers(res.headers);
  h.append("Set-Cookie", cookie);
  return new Response(res.body, { status: res.status, headers: h });
}
__name(handleRefresh, "handleRefresh");
async function handleRegister(req, env) {
  if (!await rateLimit(env, `register:${new URL(req.url).hostname}`))
    return rateLimited("too many registration attempts; try again in 60 s");
  const body = await req.json();
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  const displayName = String(body.display_name ?? "").trim() || null;
  if (!email || !password) return badRequest("email and password are required");
  if (password.length < 8) return badRequest("password must be at least 8 characters");
  const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?1 LIMIT 1").bind(email).first();
  if (existing) return badRequest("email already registered");
  const passwordHash = await hashPassword(password);
  const now = Math.floor(Date.now() / 1e3);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO users (id, email, password_hash, display_name, is_active, is_admin, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 0, ?, ?)"
  ).bind(id, email, passwordHash, displayName, now, now).run();
  const ua = req.headers.get("User-Agent");
  const { cookie } = await createSession(env.DB, id, ua);
  const res = json({ authenticated: true, user: { id, email, display_name: displayName } }, 201);
  const h = new Headers(res.headers);
  h.append("Set-Cookie", cookie);
  return new Response(res.body, { status: res.status, headers: h });
}
__name(handleRegister, "handleRegister");

// src/routes/media.ts
async function resolveUserId(req, env) {
  const token = parseSessionCookie(req.headers.get("Cookie"));
  if (!token) return null;
  const info = await lookupSession(env.DB, token);
  return info?.isActive ? info.userId : null;
}
__name(resolveUserId, "resolveUserId");
async function rateLimit2(env, key) {
  const limiter = env.API_LIMITER;
  if (!limiter) return true;
  const { success } = await limiter.limit({ key });
  return success;
}
__name(rateLimit2, "rateLimit");
async function handleMediaList(req, env) {
  const userId = await resolveUserId(req, env);
  const rateKey = userId ?? `anon:${new URL(req.url).hostname}`;
  if (!await rateLimit2(env, `media-list:${rateKey}`)) return rateLimited();
  const seriesRows = await env.DB.prepare(
    `SELECT s.id, s.name, s.overview, s.metadata_json,
            e.id AS ep_id, e.title AS ep_title, e.overview AS ep_overview
     FROM series s
     JOIN seasons sn ON sn.series_id = s.id
     JOIN episodes e ON e.season_id = sn.id
     ORDER BY s.name, sn.season_num, e.episode_num
     LIMIT 100`
  ).all();
  const seen = /* @__PURE__ */ new Map();
  for (const row of seriesRows.results ?? []) {
    if (seen.has(row.id)) continue;
    const asset = await env.DB.prepare(
      "SELECT 1 FROM assets WHERE episode_id = ?1 AND is_enabled = 1 LIMIT 1"
    ).bind(row.ep_id).first();
    let playable = !!asset;
    if (playable) {
      const right = await env.DB.prepare(
        "SELECT 1 FROM rights r WHERE r.episode_id = ?1 AND (r.user_id = ?2 OR r.user_id IS NULL) AND (r.expires_at IS NULL OR r.expires_at > ?3) LIMIT 1"
      ).bind(row.ep_id, userId ?? "__none__", Math.floor(Date.now() / 1e3)).first();
      playable = !!right;
    }
    let poster = null;
    try {
      poster = row.metadata_json ? JSON.parse(row.metadata_json).poster ?? null : null;
    } catch {
      poster = null;
    }
    seen.set(row.id, { id: row.id, title: row.name, overview: row.overview, poster_key: poster, playable, first_ep_id: row.ep_id });
  }
  return json([...seen.values()]);
}
__name(handleMediaList, "handleMediaList");
async function handleMediaDetail(req, env, _ctx, match) {
  const userId = await resolveUserId(req, env);
  const rateKey = userId ?? `anon:${new URL(req.url).hostname}`;
  if (!await rateLimit2(env, `media-detail:${rateKey}`)) return rateLimited();
  const id = param(match, "id");
  let seriesId = null;
  const seriesRow = await env.DB.prepare(
    "SELECT id FROM series WHERE id = ?1 LIMIT 1"
  ).bind(id).first();
  if (seriesRow) {
    seriesId = seriesRow.id;
  } else {
    const ep = await env.DB.prepare(
      "SELECT season_id FROM episodes WHERE id = ?1 LIMIT 1"
    ).bind(id).first();
    if (ep) {
      const sea = await env.DB.prepare(
        "SELECT series_id FROM seasons WHERE id = ?1 LIMIT 1"
      ).bind(ep.season_id).first();
      if (sea) seriesId = sea.series_id;
    }
  }
  if (!seriesId) return notFound("series not found");
  const series = await env.DB.prepare(
    "SELECT id, name, overview, metadata_json FROM series WHERE id = ?1 LIMIT 1"
  ).bind(seriesId).first();
  if (!series) return notFound("series not found");
  const seasons = await env.DB.prepare(
    "SELECT id, season_num FROM seasons WHERE series_id = ?1 ORDER BY season_num"
  ).bind(series.id).all();
  const nowTs = Math.floor(Date.now() / 1e3);
  const seasonsOut = [];
  const playableByEp = {};
  const reasonsByEp = {};
  for (const sea of seasons.results ?? []) {
    const eps = await env.DB.prepare(
      "SELECT id, episode_num, title, overview, release_date, runtime_minutes FROM episodes WHERE season_id = ?1 ORDER BY episode_num"
    ).bind(sea.id).all();
    for (const ep of eps.results ?? []) {
      const assets = await env.DB.prepare(
        "SELECT id, storage_key FROM assets WHERE episode_id = ?1 AND media_type = 'hls' AND is_enabled = 1"
      ).bind(ep.id).all();
      const reasons = [];
      if (!assets.results?.length) reasons.push("no_media");
      const right = await env.DB.prepare(
        "SELECT 1 FROM rights r WHERE r.episode_id = ?1 AND (r.user_id = ?2 OR r.user_id IS NULL) AND (r.expires_at IS NULL OR r.expires_at > ?3) LIMIT 1"
      ).bind(ep.id, userId ?? "__none__", nowTs).first();
      if (!right) reasons.push("no_rights");
      if (reasons.length === 0) playableByEp[ep.id] = assets.results.map((a) => a.id);
      else reasonsByEp[ep.id] = reasons;
    }
    seasonsOut.push({ id: sea.id, season_num: sea.season_num, episodes: eps.results ?? [] });
  }
  let poster = null;
  let fanart = null;
  try {
    if (series.metadata_json) {
      const meta = JSON.parse(series.metadata_json);
      poster = meta.poster ?? null;
      fanart = meta.fanart ?? null;
    }
  } catch {
  }
  return json({
    id: series.id,
    name: series.name,
    overview: series.overview,
    poster_key: poster,
    fanart_key: fanart,
    seasons: seasonsOut,
    playable_assets_by_episode: playableByEp,
    limitations: { reasons_by_episode: reasonsByEp }
  });
}
__name(handleMediaDetail, "handleMediaDetail");

// src/routes/search.ts
async function ftsSearch(db, q) {
  const ftsQuery = q.split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
  if (!ftsQuery) return [];
  try {
    const rows = await db.prepare(
      `SELECT e.id, e.title, e.overview
       FROM episode_fts f
       JOIN episodes e ON e.id = f.episode_id
       WHERE episode_fts MATCH ?1
       ORDER BY rank
       LIMIT 25`
    ).bind(ftsQuery).all();
    return (rows.results ?? []).map((r) => ({
      media_id: r.id,
      type: "episode",
      title: r.title,
      overview: r.overview
    }));
  } catch {
    return [];
  }
}
__name(ftsSearch, "ftsSearch");
async function likeSearch(db, q) {
  const pattern = `%${q}%`;
  const rows = await db.prepare(
    `SELECT e.id, e.title, e.overview
     FROM episodes e
     WHERE e.title LIKE ?1 OR e.overview LIKE ?1
     ORDER BY e.title
     LIMIT 25`
  ).bind(pattern).all();
  return (rows.results ?? []).map((r) => ({
    media_id: r.id,
    type: "episode",
    title: r.title,
    overview: r.overview
  }));
}
__name(likeSearch, "likeSearch");
async function handleSearch(req, env) {
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  if (!q) return badRequest("query parameter q is required");
  const limiter = env.API_LIMITER;
  if (limiter) {
    const { success } = await limiter.limit({ key: `search:${url.hostname}` });
    if (!success) return rateLimited();
  }
  let results = await ftsSearch(env.DB, q);
  if (!results.length) results = await likeSearch(env.DB, q);
  return json({ query: q, results });
}
__name(handleSearch, "handleSearch");

// src/util/presign.ts
var REGION = "auto";
var SERVICE = "s3";
var ALGORITHM = "AWS4-HMAC-SHA256";
var EMPTY_PAYLOAD_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
var SIGNED_HEADERS = "host";
async function hmac(key, data) {
  const k = key instanceof CryptoKey ? key : await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data));
}
__name(hmac, "hmac");
async function sha256hex(data) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}
__name(sha256hex, "sha256hex");
function hex2(buf) {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}
__name(hex2, "hex");
async function deriveSigningKey(secretAccessKey, dateStamp) {
  const enc = new TextEncoder();
  const kDate = await hmac(enc.encode("AWS4" + secretAccessKey), dateStamp);
  const kRegion = await hmac(new Uint8Array(kDate), REGION);
  const kService = await hmac(new Uint8Array(kRegion), SERVICE);
  const kSigning = await hmac(new Uint8Array(kService), "aws4_request");
  return crypto.subtle.importKey("raw", kSigning, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}
__name(deriveSigningKey, "deriveSigningKey");
async function presignGet(opts) {
  const method = opts.method ?? "GET";
  const ttl = Math.max(1, Math.min(opts.ttlSeconds, 604800));
  const now = opts.expiresAt ? new Date(opts.expiresAt.getTime() - ttl * 1e3) : /* @__PURE__ */ new Date();
  const expires = opts.expiresAt ?? new Date(now.getTime() + ttl * 1e3);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const endpoint = `https://${opts.accountId}.r2.cloudflarestorage.com`;
  const host = new URL(endpoint).host;
  const canonicalUri = "/" + opts.bucketKey.split("/").map(encodeURIComponent).join("/");
  const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const queryParams = new URLSearchParams({
    "X-Amz-Algorithm": ALGORITHM,
    "X-Amz-Credential": `${opts.accessKeyId}/${credentialScope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(ttl),
    "X-Amz-SignedHeaders": SIGNED_HEADERS
  });
  const sortedParams = [...queryParams.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const canonicalQuery = sortedParams.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  const canonicalHeaders = `host:${host}`;
  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, SIGNED_HEADERS, EMPTY_PAYLOAD_HASH].join("\n");
  const canonicalRequestHash = await sha256hex(canonicalRequest);
  const stringToSign = [ALGORITHM, amzDate, credentialScope, canonicalRequestHash].join("\n");
  const signingKey = await deriveSigningKey(opts.secretAccessKey, dateStamp);
  const signatureBuf = await crypto.subtle.sign("HMAC", signingKey, new TextEncoder().encode(stringToSign));
  const signature = hex2(signatureBuf);
  const url = `${endpoint}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
  return { url, expiresAt: expires };
}
__name(presignGet, "presignGet");

// src/routes/playback.ts
var HLS_CONTENT_TYPE = "application/vnd.apple.mpegurl";
async function presignKey(env, bucketKey, ttlSeconds) {
  const accountId = env.R2_ACCOUNT_ID;
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY ?? "";
  if (!accountId || !accessKeyId || !secretAccessKey) throw new Error("R2 credentials not configured");
  const { url } = await presignGet({ bucketKey, accountId, accessKeyId, secretAccessKey, method: "GET", ttlSeconds });
  return url;
}
__name(presignKey, "presignKey");
function getPresignTtl(env) {
  const raw = parseInt(env.PLAYBACK_PRESIGN_TTL_SECONDS ?? "1800", 10);
  return Math.max(60, Math.min(Number.isFinite(raw) ? raw : 1800, 604800));
}
__name(getPresignTtl, "getPresignTtl");
function dirOf(storageKey) {
  return storageKey.substring(0, storageKey.lastIndexOf("/"));
}
__name(dirOf, "dirOf");
async function resolvePlaylistKey(db, asset, rendition) {
  if (asset.rendition === rendition) return asset.storage_key;
  if (!/^[A-Za-z0-9_-]+$/.test(rendition)) throw new Error("not_found");
  const target = `${dirOf(asset.storage_key)}/${rendition}/playlist.m3u8`;
  const row = await db.prepare(
    `SELECT storage_key, is_enabled FROM assets WHERE storage_key = ?1 LIMIT 1`
  ).bind(target).first();
  if (!row) throw new Error("not_found");
  if (row.is_enabled !== 1) throw new Error("disabled");
  return target;
}
__name(resolvePlaylistKey, "resolvePlaylistKey");
async function resolveSession(req, env) {
  const token = parseSessionCookie(req.headers.get("Cookie"));
  if (!token) return null;
  const info = await lookupSession(env.DB, token);
  if (!info?.isActive) return null;
  return { userId: info.userId };
}
__name(resolveSession, "resolveSession");
async function loadAsset(db, assetId) {
  const asset = await db.prepare(
    `SELECT a.id, a.episode_id, a.storage_key, a.media_type, a.rendition, a.is_enabled
     FROM assets a WHERE a.id = ?1 LIMIT 1`
  ).bind(assetId).first();
  return asset;
}
__name(loadAsset, "loadAsset");
async function hasRight(db, episodeId, userId) {
  const nowTs = Math.floor(Date.now() / 1e3);
  const right = await db.prepare(
    `SELECT 1 FROM rights r
     WHERE r.episode_id = ?1 AND (r.user_id = ?2 OR r.user_id IS NULL)
       AND (r.expires_at IS NULL OR r.expires_at > ?3)
     LIMIT 1`
  ).bind(episodeId, userId ?? "__none__", nowTs).first();
  return !!right;
}
__name(hasRight, "hasRight");
function rewriteMaster(masterText, assetId, baseUrl, env) {
  const ttl = getPresignTtl(env);
  const lines = [];
  for (const line of masterText.split("\n")) {
    const trimmed = line.trim();
    if (trimmed !== "" && !trimmed.startsWith("#")) {
      const rendition = trimmed.split("/")[0] ?? "";
      const workerUrl = `${baseUrl}/api/playback/media/${assetId}?var=${encodeURIComponent(rendition)}`;
      lines.push(workerUrl);
    } else {
      lines.push(line);
    }
  }
  return lines.join("\n");
}
__name(rewriteMaster, "rewriteMaster");
async function rewriteMedia(text, storageKey, env) {
  const ttl = getPresignTtl(env);
  const dir = storageKey.substring(0, storageKey.lastIndexOf("/"));
  const lines = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed !== "" && !trimmed.startsWith("#")) {
      const segmentKey = `${dir}/${trimmed}`;
      try {
        const signed = await presignKey(env, segmentKey, ttl);
        lines.push(signed);
      } catch (err) {
        lines.push(`#PRESIGN_ERROR:${segmentKey}:${err.message}`);
      }
    } else {
      lines.push(line);
    }
  }
  return lines.join("\n");
}
__name(rewriteMedia, "rewriteMedia");
async function authorizePlayback(req, env, assetId) {
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
__name(authorizePlayback, "authorizePlayback");
async function handlePlaybackMaster(req, env, _ctx, match) {
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
      headers: { "content-type": HLS_CONTENT_TYPE, "cache-control": "no-store" }
    });
  } catch (err) {
    const msg = err.message;
    if (msg === "no_session") return unauthorized();
    if (msg === "not_found") return notFound("asset not found");
    if (msg === "disabled") return forbidden("asset disabled");
    if (msg === "no_rights") return forbidden("no playback rights for this session");
    if (msg === "rate_limited") return rateLimited();
    return r2Error(err);
  }
}
__name(handlePlaybackMaster, "handlePlaybackMaster");
async function handlePlaybackMedia(req, env, _ctx, match) {
  const assetId = param(match, "id");
  const rendition = searchParam(req, "var");
  if (!rendition) return json({ error: { code: "bad_request", message: "var query parameter is required" } }, 400);
  try {
    const asset = await authorizePlayback(req, env, assetId);
    const playlistKey = await resolvePlaylistKey(env.DB, asset, rendition);
    const object = await env.MEDIA_BUCKET.get(playlistKey);
    if (!object) return r2Error(new Error("NoSuchKey: rendition playlist not found"));
    const text = await object.text();
    const rewritten = await rewriteMedia(text, playlistKey, env);
    return new Response(rewritten, {
      status: 200,
      headers: { "content-type": HLS_CONTENT_TYPE, "cache-control": "no-store" }
    });
  } catch (err) {
    const msg = err.message;
    if (msg === "no_session") return unauthorized();
    if (msg === "not_found") return notFound("asset not found");
    if (msg === "disabled") return forbidden("asset disabled");
    if (msg === "no_rights") return forbidden("no playback rights for this session");
    if (msg === "rate_limited") return rateLimited();
    return r2Error(err);
  }
}
__name(handlePlaybackMedia, "handlePlaybackMedia");

// src/index.ts
var router = createRouter();
router.route("GET", "/api/health", handleHealth);
router.route("POST", "/api/auth/login", handleLogin);
router.route("POST", "/api/auth/logout", handleLogout);
router.route("GET", "/api/auth/session", handleSession);
router.route("POST", "/api/auth/refresh", handleRefresh);
router.route("POST", "/api/auth/register", handleRegister);
router.route("GET", "/api/media", handleMediaList);
router.route("GET", "/api/media/:id", handleMediaDetail);
router.route("GET", "/api/search", handleSearch);
router.route("GET", "/api/playback/master/:id", handlePlaybackMaster);
router.route("GET", "/api/playback/media/:id", handlePlaybackMedia);
router.route("GET", "/api/playback/:id", handlePlaybackMaster);
router.route("GET", "/api/v1/health", handleHealth);
router.route("POST", "/api/v1/auth/login", handleLogin);
router.route("POST", "/api/v1/auth/logout", handleLogout);
router.route("GET", "/api/v1/auth/session", handleSession);
router.route("POST", "/api/v1/auth/refresh", handleRefresh);
router.route("POST", "/api/v1/auth/register", handleRegister);
router.route("GET", "/api/v1/media", handleMediaList);
router.route("GET", "/api/v1/media/:id", handleMediaDetail);
router.route("GET", "/api/v1/search", handleSearch);
router.route("GET", "/api/v1/playback/master/:id", handlePlaybackMaster);
router.route("GET", "/api/v1/playback/media/:id", handlePlaybackMedia);
router.route("GET", "/api/v1/playback/:id", handlePlaybackMaster);
var index_default = {
  async fetch(request, env, ctx) {
    const preflight = handleCorsPreflight(request, env);
    if (preflight) return preflight;
    const res = await router.handle(request, env, ctx);
    return addCorsHeaders(request, res, env);
  }
};
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
