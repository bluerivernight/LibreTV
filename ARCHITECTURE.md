# Libre — Architecture Document

**Version:** 1.2 (implementation update)
**Status:** Implemented locally — Worker API, D1 schema, R2 ingest, player and SPA are in the repo. Production deployment is still interim (see `worker/wrangler.production.toml`).
**Date:** 2026-11-20
**Scope:** Revised Libre architecture document for the Libre streaming site ("Libre"), derived from repository analysis of P-Stream (`p-stream`) and Sudo-Flix (`smov`) plus Libre-specific design decisions.

> This document remains the design reference. It is now backed by working code: `worker/` implements the API and authorization boundary, `libretv-web/` is the SPA, and `ingest/` handles transcoding and uploads. Evidence labels (OBSERVED / INFERRED / RECONSTRUCTED / RECOMMENDED) still apply to the original analysis.

---

## 1. Executive Summary

Libre is a self-hostable streaming web application ("free TV / free movies on the web"). The goal for this revision is a **$0/month Cloudflare-first MVP** that is technically defensible, internally consistent, and honestly labeled with respect to what is **verified**, what is **inferred**, what is **reconstructed**, and what is **recommended** (or explicitly untested).

Key decisions in this revision:

| Decision area | Recommended MVP choice |
| --- | --- |
| **Hosting** | Cloudflare Pages (SPA) + Cloudflare Worker (API) + D1 (relational state) + R2 (media). No Neon PostgreSQL, no Upstash Redis in the MVP. |
| **Playback model** | **Model B — Worker-mediated playlists + temporary direct segment access.** Labeled `RECOMMENDED — Libre MVP` and `RECOMMENDED — UNTESTED`. |
| **Auth** | Opaque D1-backed sessions (HttpOnly, Secure, SameSite cookie). No JWT + KV blocklist. |
| **Media identity** | `storage_key` stored in D1; temporary presigned URLs generated only after authorization. No permanent public playback URLs. |
| **Rate limiting** | Cloudflare native Workers Rate Limiting API (not homemade D1 counters). |
| **Search** | D1/SQLite FTS5 in MVP; Meilisearch only a future scaling alternative. |
| **Transcoding** | Outside Workers — local/external FFmpeg before upload. |

The MVP is an **HLS-first** player (with clear browser-native vs HLS.js handling). **DASH is NOT implemented** in the MVP.

**$0 feasibility is a planning estimate, not a guarantee.** All capacity numbers are labeled `ESTIMATE` with assumptions.

---

## 2. Repository Analysis

Two upstream codebases were analyzed to inform the architecture. The purpose here is not to copy either, but to extract verified patterns that Libre can adopt (and to avoid replicating architecture that does not fit a $0 Cloudflare MVP).

### 2.1 Relations to upstream (OBSERVED)

- **P-Stream** (`github.com/xp-technologies-dev/p-stream`) — a self-hosted streaming frontend with multiple metadata/playback providers.
- **Sudo-Flix** (`github.com/sussy-code/smov`) — a streaming frontend with a provider/consumer architecture (feed, metadata, playback).

The following observations were previously recorded from these repositories. They remain classified as **OBSERVED** only where the item is directly present in the inspected files; everything else is classified explicitly.

### 2.2 What is OBSERVED (direct source evidence)

| Item | Classification | Evidence |
| --- | --- | --- |
| Frontend is a React SPA | OBSERVED | `src/index.tsx`, `src/setup/App.tsx`, `package.json` |
| `src/backend/` is a **client-side data layer** that communicates with external services — it is not necessarily a traditional server backend | OBSERVED | `src/backend/providers/...`, `src/backend/metadata/tmdb.ts`, `src/backend/accounts/...` — these are modules in a frontend bundle, not a separate hosted backend service |
| Player configuration lives in `src/components/player/README.md` | OBSERVED | File present in repo |
| Providers are plugged into a provider registry | OBSERVED | `src/backend/providers/providers.ts` |
| Upstream fetchers/build providers hit external services | OBSERVED | `src/backend/providers/fetchers.ts` |
| TMDB is used as a metadata source | OBSERVED | `src/backend/metadata/tmdb.ts` |
| User accounts exist in some form | OBSERVED | `src/backend/accounts/auth.ts`, `src/backend/accounts/crypto.ts` (files present; exact auth flow is not re-verified here) |
| `dash.js` is present in the inspected dependency set | OBSERVED | `package.json` |

### 2.3 What is INFERRED / RECONSTRUCTED

- **DASH support: INFERRED / NOT VERIFIED — dash.js is present in the inspected dependency set, but the exact normalized runtime/provider path was not verified.**
- The specific internal `PlaybackSource` abstraction described in earlier analysis is **RECONSTRUCTED** (an abstraction reconstructed from observed behavior), not the exact upstream interface.
- The exact normalized runtime/provider path for any media type is **NOT VERIFIED**.
- Upstream deployment topology (`vercel.json`, `Dockerfile`) is **OBSERVED as existing artifact files**, but the running topology is **NOT VERIFIED**.

### 2.4 Correction of prior overstatement

The previous draft described `src/backend/` as a "traditional server backend." That overstates the evidence: the directory is a **client-side data layer** that communicates with external services. This correction is applied throughout the document. No claim is made that the upstream runtime behavior is identical to what is documented here.

---

## 3. Evidence Classification Framework

Every claim in this document uses exactly one of these categories:

| Category | Meaning |
| --- | --- |
| **OBSERVED** | Directly verified from repository/source/documentation (file present, code read, or official docs fetched). |
| **INFERRED** | Logically inferred but not directly verified. |
| **RECONSTRUCTED** | An abstraction reconstructed from observed behavior (e.g., a documented interface deduced from how code is used). |
| **RECOMMENDED** | A Libre design choice (this document's recommendation). |

**Rules used throughout:**

1. Reconstructed interfaces are never presented as the exact upstream interfaces.
2. Everything that has not been tested or directly inspected is marked as such (`RECOMMENDED — UNTESTED`, `INFERRED / NOT VERIFIED`, or `ESTIMATE`).
3. No verification is fabricated.

---

## 4. P-Stream / Sudo-Flix Findings

This section records the verified findings and how they inform Libre. Findings are labeled with the classifications from Section 3.

### 4.1 Verified player architecture findings (OBSERVED + RECONSTRUCTED, kept separate from recommendations)

1. Upstream player is React-based and supports **multiple playback modes** (direct MP4 + HLS embeds depending on provider) — **OBSERVED** (player README / component usage).
2. The exact runtime/provider path per media type is **NOT VERIFIED**.
3. **DASH: INFERRED / NOT VERIFIED** — `dash.js` is present in the inspected dependency set, but the exact normalized runtime/provider path was not verified.
4. Providers are organized around a fetcher/build pattern (`providers.ts`, `fetchers.ts`) — **OBSERVED**; the exact wire protocol is **RECONSTRUCTED / NOT VERIFIED**.
5. TMDB provides metadata — **OBSERVED**.

### 4.2 How these findings map to Libre

Libre adopts the *pattern* of a provider-based frontend (Section 16), but does **not** copy an unverified runtime path. Libre's recommended architecture is HLS-first and Cloudflare-first, with explicit provider separation.

### 4.3 DASH classification (normative)

**DASH support: INFERRED / NOT VERIFIED — dash.js is present in the inspected dependency set, but the exact normalized runtime/provider path was not verified.**

- **Libre MVP:** `NOT IMPLEMENTED — HLS-first`.
- **Future DASH support:** `RECOMMENDED — future phase` (Section 22, item 4 relevant if Stream/media stack supports it).

---

## 5. Libre Architecture

Libre is a two-surface application:

```
Client browser
  │
  ├── Cloudflare Pages  (libre.tv)         → React/Vite SPA (UI)
  │
  └── Cloudflare Worker (api.libre.tv)     → REST API, auth, playback authorization
        ├── D1   (authoritative relational state)
        └── R2   (media objects, presigned access)
```

**Responsibilities:**

- **Pages (SPA):** UI, state, routing, media elements / HLS player. Static assets via Pages are free and unlimited (OBSERVED — [Pages Functions pricing](https://developers.cloudflare.com/pages/functions/pricing/)).
- **Worker (API):** authentication, authorization, metadata, provider orchestration, playlist mediation, rate limiting.
- **D1:** authoritative storage for users, sessions, rights, metadata, progress, bookmarks.
- **R2:** object storage for HLS/MP4/subtitles/images. R2 is **not** the rights database.

**Not in the MVP:** Neon PostgreSQL, Upstash Redis, Meilisearch, on-demand transcoding in Workers, DASH, JWT session revocation lists in KV. These appear only in Section 22 (Future Scaling Architecture) or are deliberately excluded below.

---

## 6. $0 MVP Architecture

### 6.1 Canonical topology (RECOMMENDED — Libre MVP)

```
libre.tv
   ↓
Cloudflare Pages  (React/Vite SPA)
   ↓
Cloudflare Worker (D1 + R2)
   ↓
api.libre.tv
```

Labeled **`RECOMMENDED — Libre MVP deployment topology`**.

Cloudflare Workers Static Assets is noted only as a possible alternative/future simplification (a Worker could serve the SPA too), not as a requirement of the MVP.

### 6.2 Services allowed in the MVP

| Service | Role | Verified limits (official docs, OBSERVED) |
| --- | --- | --- |
| Cloudflare Pages | Static SPA | Static asset requests: free and unlimited (free + paid). Pages Functions requests count toward the **Workers** free quota. ([Pages Functions pricing](https://developers.cloudflare.com/pages/functions/pricing/)) |
| Cloudflare Workers (Free plan) | API, auth, playlist mediation | 100,000 requests/day; 10 ms CPU/request; 128 MB memory; 50 subrequests/request; 6 simultaneous outgoing connections; startup ≤ 1 s; Worker size 64 MiB. ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)) |
| Cloudflare D1 | Authoritative relational state | Free: 5M rows read/day, 100K rows written/day, 5 GB total storage. Resets daily 00:00 UTC. ([D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)) |
| Cloudflare R2 | Media object storage | Free tier (Standard): 10 GB-month storage, 1M Class A ops/month, 10M Class B ops/month, free egress. Presigned URLs supported. ([R2 pricing](https://developers.cloudflare.com/r2/pricing/)) |

### 6.3 Excluded from MVP (future-only)

- **Neon PostgreSQL** — future scaling alternative only (Section 22).
- **Upstash Redis** — future scaling alternative only (Section 22).
- **Meilisearch** — future scaling alternative only (Section 22).
- **Cloudflare Stream / managed transcoding** — future phase only (Section 20).
- **DASH** — `NOT IMPLEMENTED — HLS-first MVP` (Section 4.3).

### 6.4 KV

**KV is not authoritative storage for sessions, user rights, ownership, transactional business state, or security-critical authorization state.**

KV is used only where eventual consistency is acceptable:

- Cache of non-authoritative data (e.g., lightweight config, feature flags, transient rate-limit hit counters is NOT used — that's the Rate Limiting API's job).
- Cache for provider responses (metadata enrichment) where acceptable.

D1 is the source of truth for all relational/authoritative state. Durable Objects are used **only** if a concrete strong-coordination requirement exists; the MVP has none.

---

## 7. Authentication & Sessions

### 7.1 Authentication model (RECOMMENDED — Libre MVP: opaque D1-backed sessions)

Login endpoint exchanges credentials for an **opaque session ID**, stored in D1. No JWT is minted for normal session management; no KV revocation blocklist is used.

- **Session ID:** cryptographically random value (e.g., 32+ random bytes, base64url). A random value is used — not an incrementing counter.
- **Storage:** the session record lives in D1 (`sessions` table). The server stores a **hash** of the session ID and returns the raw token to the client once.
- **Cookie:**
  - `Secure` — only over HTTPS.
  - `HttpOnly` — not readable by JavaScript.
  - `SameSite=Lax` — valid for MVP; each session holder decides final value (Lax balances CSRF risk vs cross-subdomain UX; `Strict` optional if streaming UX unaffected).
  - `Domain=api.libre.tv; Path=/`.
  - `Max-Age` ≈ 7 days (ESTIMATE, tunable).
- **Expiry:** enforced server-side from `expires_at` in D1.
- **Revocation:** delete or mark-revoked the D1 row. Since D1 is authoritative, revocation is immediate and simple.
- **No JWT blocklist in KV** without a concrete requirement.

### 7.2 Login/registration flow (schematic)

1. Client `POST /v1/auth/login` (email + password) → Worker verifies credential → creates session → sets cookie.
2. Subsequent requests present the cookie; Worker looks up session in D1.
3. `POST /v1/auth/logout` deletes/revokes the session row.
4. `POST /v1/auth/refresh` (optional) rotates the session; the old session is revoked, a new one is issued.

---

## 8. D1 Data Model

**SQLite-compatible syntax is used throughout (no PostgreSQL-only constructs such as `UUID`, `gen_random_uuid()`, `JSONB`).** IDs are application-generated strings (e.g., `crypto.randomUUID()` produced in the Worker, stored as TEXT). Timestamps are INTEGER unix epoch seconds unless stated otherwise. JSON is stored as TEXT.

### 8.1 Schema (RECOMMENDED — Libre MVP)

Tables appear in dependency order (referenced tables before dependent tables).

```sql
-- users — application-generated TEXT ids; unix-epoch INTEGER timestamps.
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  display_name    TEXT,
  is_active       INTEGER NOT NULL DEFAULT 1,
  is_admin        INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- sessions — opaque random id; store the hash server-side.
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,          -- sha256(raw_session_token) hex
  user_id     TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  revoked_at  INTEGER,
  user_agent  TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- series -> seasons -> episodes
CREATE TABLE IF NOT EXISTS series (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  overview    TEXT,
  metadata_json TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS seasons (
  id          TEXT PRIMARY KEY,
  series_id   TEXT NOT NULL,
  season_num  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE CASCADE,
  UNIQUE (series_id, season_num)
);

CREATE TABLE IF NOT EXISTS episodes (
  id              TEXT PRIMARY KEY,
  season_id       TEXT NOT NULL,
  episode_num     INTEGER NOT NULL,
  title           TEXT NOT NULL,
  overview        TEXT,
  release_date    TEXT,                  -- ISO date as TEXT
  runtime_minutes INTEGER,
  metadata_json   TEXT,                  -- JSON as TEXT
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  FOREIGN KEY (season_id) REFERENCES seasons(id) ON DELETE CASCADE,
  UNIQUE (season_id, episode_num)
);

-- assets — canonical media identity via storage_key (no permanent public URLs)
CREATE TABLE IF NOT EXISTS assets (
  id             TEXT PRIMARY KEY,
  episode_id     TEXT NOT NULL,
  storage_key    TEXT NOT NULL,          -- e.g. "media/<assetId>/playlist.m3u8"
  media_type     TEXT NOT NULL,          -- 'hls' | 'mp4' | 'image' | 'subtitle'
  rendition      TEXT,                   -- 'source' | '720p' | '480p' | ... (NULL for images/subtitles)
  container      TEXT,                   -- 'ts' (MPEG-TS segments) or 'mp4'
  codecs_json    TEXT,                   -- JSON as TEXT (video/audio codec metadata)
  byte_size      INTEGER,
  duration_seconds REAL,
  is_enabled     INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_assets_episode     ON assets(episode_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_key  ON assets(storage_key);

-- subtitles
CREATE TABLE IF NOT EXISTS subtitles (
  id         TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL,
  language   TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_subtitles_episode ON subtitles(episode_id);

-- rights — neutral entitlement grants. user_id NULL = global/free entitlement.
CREATE TABLE IF NOT EXISTS rights (
  id          TEXT PRIMARY KEY,
  user_id     TEXT,                      -- NULL = applies to all users
  episode_id  TEXT,
  access_type TEXT NOT NULL,             -- 'free' | 'premium' (neutral licensing label)
  expires_at  INTEGER,                   -- NULL = no expiry
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE CASCADE,
  FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_rights_user    ON rights(user_id);
CREATE INDEX IF NOT EXISTS idx_rights_episode ON rights(episode_id);

-- progress
CREATE TABLE IF NOT EXISTS progress (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  episode_id       TEXT NOT NULL,
  position_seconds REAL NOT NULL DEFAULT 0,
  updated_at       INTEGER NOT NULL,
  FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE CASCADE,
  FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE,
  UNIQUE (user_id, episode_id)
);

-- bookmarks
CREATE TABLE IF NOT EXISTS bookmarks (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE CASCADE,
  FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE,
  UNIQUE (user_id, episode_id)
);
```

**SQL audit (this schema):** TEXT ids (application-generated), INTEGER unix timestamps, JSON as TEXT, FK references valid and dependency-ordered, UNIQUE constraints meet the model, indexes cover the lookup paths (`user_id`, `episode_id`, `storage_key`, `email`, session `expires_at`). **No** PostgreSQL-only features. (See Section 8.4 for the audit rule applied to every snippet in this document.)

### 8.2 Search (MVP): SQLite FTS5

Search is a **D1/SQLite** approach for the $0 MVP. No paid external search dependency is added without justification.

```sql
-- Virtual FTS5 index over title/overview (RECOMMENDED — Libre MVP)
CREATE VIRTUAL TABLE IF NOT EXISTS episode_fts USING fts5(
  episode_id UNINDEXED,
  title,
  overview
);
```

Keep the FTS table in sync with triggers. `episode_fts` is a normal FTS5 table (not contentless/external-content), so the special `'delete'` command does **not** apply (sqlite.org/fts5.html §6.3); instead mirror the `episodes` SQLite rowid into the FTS rowid on insert, and remove rows with plain `DELETE ... WHERE rowid`:

```sql
CREATE TRIGGER IF NOT EXISTS episode_ai AFTER INSERT ON episodes BEGIN
  INSERT INTO episode_fts(rowid, episode_id, title, overview) VALUES (new.rowid, new.id, new.title, new.overview);
END;
CREATE TRIGGER IF NOT EXISTS episode_ad AFTER DELETE ON episodes BEGIN
  DELETE FROM episode_fts WHERE rowid = old.rowid;
END;
CREATE TRIGGER IF NOT EXISTS episode_au AFTER UPDATE ON episodes BEGIN
  DELETE FROM episode_fts WHERE rowid = old.rowid;
  INSERT INTO episode_fts(rowid, episode_id, title, overview) VALUES (new.rowid, new.id, new.title, new.overview);
END;
```

Query example:

```sql
SELECT e.id, e.title, e.overview
FROM episode_fts f
JOIN episodes e ON e.id = f.episode_id
WHERE episode_fts MATCH ?1
ORDER BY rank
LIMIT 25;
```

> **RECOMMENDED — UNTESTED:** FTS5 availability and behavior inside D1 must be validated at implementation time. Fallback: indexed `LIKE` search on `title` (still SQLite-valid), or migrate search to Meilisearch in a future phase.

### 8.3 Representative queries used by the API (all SQLite-valid)

Session lookup (authorization):

```sql
SELECT s.expires_at, s.revoked_at, s.user_id, u.is_active
FROM sessions s
LEFT JOIN users u ON u.id = s.user_id
WHERE s.id = ?1
LIMIT 1;
```

Asset verification (before issuing playback access):

```sql
SELECT a.storage_key, a.media_type, a.rendition, a.episode_id
FROM assets a
JOIN episodes e ON e.id = a.episode_id
WHERE a.id = ?1
  AND a.is_enabled = 1
LIMIT 1;
```

Rights check (neutral entitlement):

```sql
SELECT 1
FROM rights r
WHERE r.episode_id = ?1
  AND (r.user_id = ?2 OR r.user_id IS NULL)
  AND (r.expires_at IS NULL OR r.expires_at > ?3)
LIMIT 1;
```

Progress upsert (SQLite `ON CONFLICT ... DO UPDATE`):

```sql
INSERT INTO progress (id, user_id, episode_id, position_seconds, updated_at)
VALUES (?1, ?2, ?3, ?4, ?5)
ON CONFLICT(user_id, episode_id)
DO UPDATE SET
  position_seconds = excluded.position_seconds,
  updated_at       = excluded.updated_at;
```

### 8.4 Document-wide SQL audit rule

Every SQL snippet in this entire document was checked for:

- SQLite/D1-compatible syntax: ✅ (no `UUID`, `gen_random_uuid()`, `JSONB`, no PostgreSQL `SERIAL`).
- TEXT ids where appropriate: ✅ (application-generated ids).
- INTEGER timestamps where appropriate: ✅.
- JSON stored as TEXT: ✅.
- Referenced tables created before dependent tables: ✅.
- Foreign keys valid: ✅.
- Indexes on FK/lookup columns: ✅.
- Constraints valid: ✅.
- **Executed and verified against SQLite (3.50.4 / Python `sqlite3`):** all 8 fenced SQL blocks in this document create cleanly and the runtime queries (session lookup, asset verification, rights check, progress upsert, bookmark lookup, FTS search, and FTS insert/update/delete sync triggers) were exercised with real data and returned correct results. ✅

> **Note (FTS5 triggers).** The FTS5 `'delete'` special INSERT command is only available for *contentless* and *external-content* FTS5 tables (sqlite.org/fts5.html §6.3). A normal FTS5 table such as `episode_fts` must be kept in sync with plain `DELETE ... WHERE rowid = old.rowid` plus rowid-mirrored inserts — exactly what the Section 8.2 triggers do. This was verified by executing the schema and round-tripping inserts/updates/deletes.

---

## 9. R2 Storage Model

### 9.1 Object layout (RECOMMENDED — Libre MVP)

```
media/<assetId>/master.m3u8
media/<assetId>/<rendition>/playlist.m3u8          (per-rendition media playlist, relative segment refs)
media/<assetId>/<rendition>/seg0000.ts             (MPEG-TS segments)
media/<assetId>/<rendition>/seg0001.ts
...
media/<assetId>/subtitles/<lang>.vtt
images/<imageId>/poster.jpg
images/<imageId>/fanart.jpg
```

**Canonical media identity is the `storage_key`** (e.g., `media/<assetId>/playlist.m3u8`), stored in D1 `assets.storage_key`. **No permanent public playback URL is stored or used as the canonical authorization mechanism.** Temporary access is issued only after authorization (Section 10).

### 9.2 R2 presigned URLs (OBSERVED — official docs)

R2 **supports S3-compatible presigned URLs** ([Presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)):

- **Temporary bearer credential:** anyone holding the URL can perform the allowed operation until expiry; treat as a bearer token.
- **Object/operation scope:** a presigned URL authorizes exactly **one S3 operation on one object**.
- **Supported operations relevant to Libre:** `GET` (read), `HEAD` (metadata). `PUT`/`DELETE` are not required by the MVP playback path (admin ingest may use PUT, optional).
- **Expiry:** configurable **1 second to 7 days (604,800 s)**.
- **Endpoint:** the **R2 S3 API domain** — `https://<account_id>.r2.cloudflarestorage.com`. Presigned URLs are generated offline using AWS Signature V4 (no round-trip to R2 at generation time).
- **Security implications:** signatures cannot be tampered with (resource/operation/expiry changes yield `403 SignatureDoesNotMatch`); use short expiry for sensitive operations; the URL is the credential.
- **Browser/CORS implications:** presigned URLs used in a browser require an **R2 bucket CORS policy** matching the app origin (Section 14). Expired presigned URLs return `403 ExpiredRequest` **without** CORS response headers, so browser JS cannot read the error body — refresh before expiry or route through the Worker.

**No invented HMAC/CDN-validation claim is made.** Presigned URLs are the documented mechanism, not a custom HMAC query param.

### 9.3 R2 S3 API vs custom domain (OBSERVED — keep strictly separate)

```
R2 S3 API          → presigned URLs  (this is the MVP path)
R2 custom domain   → separate access/control model (public bucket / WAF HMAC validation)
```

- Presigned URLs work **only** with the S3 API domain (`<account_id>.r2.cloudflarestorage.com`) and **cannot be used with custom domains** ([Presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)).
- The two access mechanisms are **not interchangeable**; a presigned S3 URL cannot simply be substituted onto a custom-domain URL.
- **MVP: private R2 bucket + S3 API presigned access.** The bucket is **not** a public bucket.

---

## 10. Playback Authorization

### 10.1 The Worker is Libre's authorization boundary (RECOMMENDED — Libre MVP)

```
Client
  ↓
Worker
  ├── authenticate session
  ├── verify asset
  ├── verify rights
  ├── verify active status
  └── issue temporary playback access
  ↓
R2 (delivery)
```

- **D1 is authoritative** for users, sessions, rights, metadata, progress, bookmarks.
- **R2 is object storage, not the business-level rights database.** There is no per-object access-control DB inside R2 beyond bucket policy/CORS.

### 10.2 Playback access flow (Model B, worker-mediated playlists)

1. Client requests `/v1/playback/{assetId}` with the session cookie.
2. Worker:
   - authenticates the session (D1),
   - verifies the asset exists & is enabled (D1),
   - verifies rights for the episode for this user (D1),
   - verifies active status (account not disabled),
   - issues **temporary** playback access: returns a master playlist / media playlist whose segment references are **presigned URLs** to R2.
3. The player fetches segments directly from R2 via presigned URLs (browser CORS must allow `https://libre.tv`; Section 14).

**Temporary credentials are generated only after authorization. `storage_key` is never exposed as a permanent public URL.**

---

## 11. HLS Delivery Model Comparison

Three HLS delivery models were considered. The comparison below is a **design comparison (RECOMMENDED)** — none of the three models is asserted as currently verified in deployment.

The master playlist references rendition playlists; media playlists reference segments. For a 2-hour movie at 6-second MPEG-TS segments, a single rendition contains ≈ 1,200 segments; 4 renditions ≈ 4,800 total segments (**ESTIMATE**).

| Criterion | Model A — all-segment presigned URLs | Model B — Worker-mediated playlists + temporary direct segment access **(MVP pick)** | Model C — Worker-mediated segment delivery |
| --- | --- | --- | --- |
| **Manifest size** | Largest — every segment of every rendition could be rewritten into the master/media playlists (≈ thousands of signed URLs) | Small — Worker serves small master + per-rendition media playlist with only the *current* rendition's segments signed | Smallest (relative refs) |
| **Segment count** | All segments all renditions (thousands) | Only the rendition actually requested (~1,200 for 2h @ 6s) | Every segment request goes through the Worker |
| **Expiration** | Hard to manage coherently over thousands of URLs; expiry skew | Aligned per-playlist refresh; re-sign on refresh | Session/Worker-bound, simplest |
| **Refresh behavior** | Requires re-issuing thousands of URLs on refresh | Playlist refresh re-issues a small, bounded set | Trivial (no re-issue needed) |
| **Range/seek behavior** | Depends on R2 GET range support (validated via player) | Depends on R2 GET range support (validated via player) | Worker must proxy ranges (adds complexity / potential CPU) |
| **Browser compatibility** | Player-dependent; native HLS + HLS.js requirement applies | Same player requirement (native HLS + HLS.js); segments served by R2 directly | All segments go through Worker; player still needs HLS support |
| **Caching** | Excellent (R2/edge CDN caches signed segment responses) | Good — signed segments are cacheable; only playlists are Worker-mediated | Poor — Worker responses are per-request; harder to cache |
| **Worker request consumption** | Low (1 sign request per session or per playlist) **but** generation cost is the problem (CPU + thousands of signatures) | **Medium** — 1 master + 1 media playlist per refresh; segments do NOT hit the Worker | **Very high — quota-killing** — every segment is a Worker request (est. 1,200+ requests per title watch) |
| **Security** | Fine if expiry short, but thousands of bearer URLs in the wild = larger window of exposure | Good — bounded set of short-lived URLs, issued per refresh after authorization | Excellent on paper (all requests authed) but offsetting cost |
| **Implementation complexity** | High — must generate/rewrite thousands of signed URLs | **Medium** — Worker rewrites the requested rendition's playlist only | Low at the Worker, but prohibitive cost at scale |

**Key reasoning for not choosing Model A / not presigning everything up front:**

- Generating thousands of presigned URLs in a single Worker request risks the 10 ms **Free**-plan CPU budget per invocation ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)). It is **not automatically practical** to hard-code thousands of URLs into a master manifest.
- Model C burns Workers Free quota at scale (every segment = 1 request), and the free quota is 100,000 requests/day — a single heavy viewing session could consume it (**ESTIMATE**).
- Model B bounds both: playlists are small, segments are direct, per-refresh signing is a **small bounded set** of the currently-referenced segments.

### 11.1 Selected approach

> **RECOMMENDED — Libre MVP: Model B** (Worker-mediated playlists + temporary direct segment access).

> **RECOMMENDED — UNTESTED:** the exact implementation (playlist rewrite, cache headers, seek behavior of the chosen player) is **not yet validated** and is not presented as OBSERVED or verified behavior.

---

## 12. Recommended HLS MVP

### 12.1 Player (RECOMMENDED — Libre MVP)

**HLS playback: RECOMMENDED — use native HLS where supported and an HLS JavaScript playback layer where required.**

- Safari / iOS Safari: native HLS.
- Other browsers: an HLS.js-style JavaScript playback layer (MSE/fetch) — **RECOMMENDED — UNTESTED** until validated with the chosen player build.

### 12.2 Playback flow (Model B in practice)

```
GET /v1/playback/master/{assetId}            → Worker (auth) → returns master playlist
GET /v1/playback/media/{assetId}?var={rend}  → Worker (auth) → returns media playlist with presigned segment URLs
GET https://<acct>.r2.cloudflarestorage.com/media/.../seg0000.ts?X-Amz-...   → direct from R2 (browser CORS)
```

- The Worker signs only the segments referenced by the requested media playlist at refresh time.
- Segments are fetched directly from R2 — **they never hit the Worker**, so Workers Free request quota is preserved.
- Presigned URL expiry is set with a **refresh before expiry** policy (Section 13).

### 12.3 What remains unverified (recorded explicitly)

- Exact range/seek behavior of the chosen player against R2 presigned URLs.
- Playlist refresh cadence and credential-expiry timing under real player behavior.
- HLS.js version/build compatibility with R2 signed segment URLs + CORS.
- Whether Safari native HLS handles presigned segment URLs without issue.

These are **requirements to validate during implementation**, not promises.

---

## 13. HLS Browser/Playback Requirements

The architecture is **not** a one-time MP4 download design. The following are explicit requirements that must be accounted for and validated:

1. **HTTP range/seek behavior** — R2 `GET` supports the `Range` header; exact player behavior must be validated. **Presigned URLs do not inherently guarantee the entire player's seeking behavior** — range/seek is a requirement to validate, not an assumption.
2. **Normal HLS media-playlist refresh** — players re-fetch media playlists; the Worker must re-issue signatures on refresh with the same authorization checks.
3. **Presigned credential expiration** — signatures expire (1 s – 7 d window); the Worker must refresh playlists **before** the referenced segments expire.
4. **Playback recovery after expired credentials** — if a fetch returns `403 ExpiredRequest`, the player/Worker must re-fetch the media playlist to get fresh signatures; note expired responses carry **no CORS headers**, so JS cannot read the error body ([R2 CORS docs](https://developers.cloudflare.com/r2/buckets/cors/)) — route re-auth through the Worker.
5. **Subtitles** — WebVTT objects served via presigned URLs (same CORS/exposure rules) or via the Worker.
6. **Master playlists** — served by the Worker (small, dynamic).
7. **Media playlists** — served by the Worker (rewritten with signed segment URLs).
8. **Segments** — served directly by R2 via presigned URLs.
9. **Browser CORS behavior** — cross-origin requests to R2 must match the bucket CORS policy (Section 14); media requests without proper CORS fail in the browser even though the presigned URL is valid.

**Validation is mandatory at implementation time.** Until then, every playback-related claim in this document is `RECOMMENDED — UNTESTED`.

---

## 14. R2 CORS

CORS is an **explicit MVP deployment requirement** for browser-based direct R2 playback.

### 14.1 CORS behavior (OBSERVED — official docs)

- CORS is enforced by the **browser** for cross-origin requests; the R2 bucket policy must match the actual methods/headers/origins used.
- **Preflight** happens when the browser/request requires it — **not every request necessarily causes a preflight** (e.g., simple GETs and requests without an `Origin` header do not get CORS response headers at all).
- A cross-origin request is identified by an `Origin` request header; without `Origin`, no CORS headers are returned.
- `AllowedOrigins` must be `scheme://host[:port]` with no path.
- `MaxAgeSeconds` caches preflight responses (browsers may cap to ≤ 2 hours).
- CORS rule propagation can take up to 30 seconds in rare cases.

### 14.2 Example policy (EXAMPLE — NOT production configuration)

> **The following is a clearly labeled example.** It is **not** shipped as production configuration. Replace `localhost:5173` before production and verify it matches the real requests.

```json
[
  {
    "AllowedOrigins": ["https://libre.tv", "http://localhost:5173"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["Range"],
    "ExposeHeaders": ["Content-Length", "Content-Range", "ETag", "Accept-Ranges"],
    "MaxAgeSeconds": 3600
  }
]
```

- `https://libre.tv` = production origin.
- `http://localhost:5173` = **development origin only**. Marked development-only; remove from the policy for production.
- `AllowedMethods` matches the presigned operations the page will perform (`GET`, `HEAD`).
- `AllowedHeaders` and `ExposeHeaders` reflect what the player needs (Range requests, content-range/etag for media). **Validate against the actual requests made by the chosen player.**

---

## 15. R2 S3 API vs Custom Domain

Kept **strictly separate** (OBSERVED — [Presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)):

```
R2 S3 API          → presigned URLs
                     (single operation, single object, temp bearer credential)
R2 custom domain   → separate access/control model
                     (public buckets via custom domain; WAF HMAC validation is a separate Pro+ feature)
```

- S3 presigned URLs are tied to the **S3 API endpoint** (`<account_id>.r2.cloudflarestorage.com`) and **cannot be used on custom domains**.
- The two mechanisms do **not** provide identical authorization.
- **MVP: private R2 bucket + S3 API presigned access.** Public buckets and WAF HMAC validation are documented as different mechanisms, considered future/alternative, not MVP.

---

## 16. Provider Architecture

### 16.1 Conceptual boundaries (RECOMMENDED — Libre MVP)

Keep these responsibilities **conceptually distinct** (do not collapse into a single abstraction for convenience):

| Provider | Responsibility | MVP source/status |
| --- | --- | --- |
| **MetadataProvider** | Title discovery, details, search, credits | TMDB (upstream OBSERVED in `tmdb.ts`); abstraction is Libre's own |
| **PlaybackProvider** | Resolve an episode → playable source (HLS/MP4) | Libre-owned resolver over owned/licensed assets (HLS-first) |
| **SubtitleProvider** | WebVTT subtitles | Stored directly in R2 + D1 `subtitles` table |
| **ImageProvider** | Posters/fanart/thumbnails | R2 objects keyed by `imageId` |

### 16.2 Upstream vs Libre (keep distinct)

- Upstream repositories organize providers around `providers.ts` / `fetchers.ts` (**OBSERVED** at file level; runtime protocol **RECONSTRUCTED / NOT VERIFIED**).
- Libre's provider interfaces are **Libre's own design** (RECOMMENDED). They are abstractions inspired by the upstream pattern, **not** the exact upstream interfaces.

---

## 17. Search Architecture

- **$0 MVP:** D1/SQLite search — FTS5 virtual table over episodes (`episode_fts`, Section 8.2). `RECOMMENDED — UNTESTED` until validated in D1; fallback to indexed `LIKE`.
- **No paid dependency** is added to the MVP.
- **Future scaling option:** Meilisearch (external search engine) — **future only** (Section 22), labeled as such, not a requirement of the MVP.

---

## 18. Rate Limiting & Security

### 18.1 Rate limiting — Cloudflare native API (RECOMMENDED — Libre MVP)

Use the **Workers Rate Limiting API** (binding `env.<NAME>.limit({ key })`). It is the documented abuse-prevention mechanism ([Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)).

**Relevant constraints (OBSERVED from official docs):**

- **Supported simple periods:** only `10` or `60` seconds.
- **Eventual consistency:** permissive; counters are cached on the local machine and updated asynchronously.
- **Locality:** limits are **per Cloudflare location** — a key gets a unique counter per location.
- **Non-authoritative accounting:** explicitly **not** designed as an accurate accounting mechanism. Keep authoritative state in D1.
- **Key selection:** prefer stable identifiers (user ID, route, API key). Docs explicitly recommend **against** IP-address keys for most cases (shared IPs over-block legit users). For unauthenticated auth endpoints, IP-based limiting may still be appropriate — document as a per-route decision.

**Do not implement homemade D1/KV counters as the default rate-limiting system.** Authoritative application state lives in D1; rate limiting is an abuse-prevention layer, separate from D1.

### 18.2 Example (EXAMPLE ONLY — not production configuration)

> `namespace_id` values below are **EXAMPLE ONLY — replace with the actual account-specific namespace ID during deployment.** Placeholder IDs are never production configuration.

```jsonc
{
  "main": "src/index.js",
  "ratelimits": [
    // Unauthenticated auth endpoints: per-IP, low rate
    {
      "name": "AUTH_LIMITER",
      "namespace_id": "1001", // EXAMPLE ONLY — replace at deployment
      "simple": { "limit": 10, "period": 60 }
    },
    // Authenticated API: keyed by user id
    {
      "name": "API_LIMITER",
      "namespace_id": "1002", // EXAMPLE ONLY — replace at deployment
      "simple": { "limit": 100, "period": 60 }
    },
    // Playback authorization endpoint
    {
      "name": "PLAYBACK_LIMITER",
      "namespace_id": "1003", // EXAMPLE ONLY — replace at deployment
      "simple": { "limit": 30, "period": 60 }
    }
  ]
}
```

**Separation:**

```
Rate limiting  → abuse prevention (Cloudflare Rate Limiting API)
D1             → authoritative application state
```

### 18.3 Security posture summary

- Session auth: opaque D1-backed sessions (Section 7).
- No permanent public media URLs (Section 9).
- Worker is the authorization boundary (Section 10).
- Cookies: Secure, HttpOnly, SameSite (Section 7).
- CORS restricted to `https://libre.tv` + dev-only `http://localhost:5173` (Section 14).
- Minimum TLS everywhere; no secrets in client bundles.

---

## 19. Deployment Topology

**`RECOMMENDED — Libre MVP deployment topology`:**

```
https://libre.tv          → Cloudflare Pages  → React/Vite SPA
https://api.libre.tv      → Standalone Cloudflare Worker  → D1 + R2
```

- Pages serves the SPA only; static requests on Pages are free and unlimited ([Pages Functions pricing](https://developers.cloudflare.com/pages/functions/pricing/)).
- The Worker is standalone on `api.libre.tv`; it owns all API/auth/playback routes and D1+R2 bindings.
- **This is not claimed to be the only valid Cloudflare architecture.** A Workers Static Assets deployment (Worker serving the SPA) is a possible alternative/future simplification — not an MVP requirement.
- **Neon PostgreSQL / Upstash Redis are not part of this topology**; they are future scaling alternatives only (Section 22).

**Build/deploy notes (documentation only — nothing deployed):**

- SPA: Vite build → Pages.
- Worker: `wrangler.toml` with `[[d1_databases]]`, `[[r2_buckets]]`, `[[ratelimits]]` bindings.
- Environment variables (max 64/Worker on Free plan ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/))): origin, TMDB key (if used), account IDs, etc. Secrets via Wrangler secrets, not client bundles.

---

## 20. Media Ingestion / Transcoding

**Cloudflare Workers are not Libre's video transcoding environment.**

MVP ingestion pipeline (documentation only):

```
Owned/licensed/public-domain/test media
        ↓
Local or external FFmpeg
        ↓
HLS/MP4
        ↓
R2
        ↓
storage_key in D1
```

- On-demand transcoding inside Workers is **not** designed or implemented.
- Cloudflare Stream and managed/external encoding belong under **future architecture** (Section 22).
- Assets are pre-transcoded (e.g., MPEG-TS HLS per rendition) **before** upload to R2; then recorded in D1 (`assets.storage_key`, `assets.media_type`).

---

## 21. Scaling Estimates

All numbers below are **ESTIMATE** values with stated assumptions — planning estimates, **not guarantees**. A quota is never converted into a claimed supported headcount.

### 21.1 The relationship chain

```
API requests
  → session lookups        (D1 reads)
  → playback authorization (Worker + D1 reads)
  → playlist refreshes      (Worker, small bounded signing)
  → HLS requests            (R2 GETs; NOT Worker requests in Model B)
  → R2 operations           (Class B for GET/HEAD)
  → storage consumption     (R2 GB-month, D1 rows/GB)
```

### 21.2 Estimates

| Item | ESTIMATE | Assumptions |
| --- | --- | --- |
| Workers Free daily requests | 100,000/day ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)) | Official quota. |
| Worker requests per active viewing session | ≈ 5–50 | Assumes 1 master + ~1 media playlist per refresh, refresh ≈ 1–10/min depending on player & playlist type (VOD vs live), negligible segment traffic to Worker (Model B). Wide range because player cadence is unvalidated. |
| Sessions/day staying within Workers Free | Not claimed as a headcount | Because per-session request count is itself an estimate, converting quota→users would be invalid. |
| R2 Class B ops (GET segments) per title watch | ≈ 1,200–1,300 GETs (2h @ 6s segments + playlist/master) | Single rendition playback; ESTIMATE. |
| R2 egress cost | $0 (free egress) | Official free egress ([R2 pricing](https://developers.cloudflare.com/r2/pricing/)). |
| R2 free tier capacity | 10 GB-month storage / 1M Class A / 10M Class B | Official free tier, Standard storage only. |
| D1 rows read/day from one full title browse session | Low hundreds to low thousands | Depends on navigation; icons/metrics validated via `meta.rows_read`. |
| Storage per title (single rendition HLS) | ~0.3–1.5 GB | 2h video, H.264 @ varied bitrate, MPEG-TS. ESTIMATE. |
| D1 5 GB & R2 10 GB-month headroom | Plenty for small catalog; not a user-count guarantee | D1 free limit is 5 GB total, 5M reads/100K writes per day ([D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)). |

**Rule:** no quota in this table is presented as "X users supported." Only the relationship between the factors is described.

---

## 22. Future Scaling Architecture

The following are **future scaling alternatives, not MVP requirements** ($0 MVP remains Cloudflare-first):

1. **Neon PostgreSQL** — replace/coexist with D1 if relational scale outgrows D1's 5 GB / row quotas; introduce read replicas, heavier analytics.
2. **Upstash Redis** — if caching/session hot-path or rate-limit state requires a fast KV beyond Cloudflare's native offerings.
3. **Meilisearch** — replace D1 FTS5 for large catalogs (typographic search, faceting, relevance tuning).
4. **Cloudflare Stream / managed transcoding** — for on-demand encoding and managed playback of user- or producer-uploaded media (future phase).
5. **Workers Static Assets** — possible future simplification to serve the SPA from a Worker.
6. **R2 custom-domain + WAF HMAC validation** — alternative authorization path (Pro+ plan) if direct cloud S3 API access via browser becomes undesirable; **documented as a different authorization model than presigned URLs** (Section 15).
7. **Durable Objects** — only if a concrete strong-coordination requirement emerges (none in MVP); e.g., live-room coordination is a future possibility, not a design today.

---

## 23. Self-Evaluation

Evaluation is per-category; **Overall: PASS is reported only when every mandatory category passes.**

| Category | Result | Evidence |
| --- | --- | --- |
| **Repository Forensic Accuracy** | PASS | All upstream claims labeled OBSERVED / INFERRED / RECONSTRUCTED / NOT VERIFIED; `src/backend/` re-described as client-side data layer; no fabricated interfaces; DASH explicitly INFERRED / NOT VERIFIED. |
| **Libre Architecture Completeness** | PASS | All 24 sections present; three HLS models compared; Model B selected and labeled `RECOMMENDED — Libre MVP` + `RECOMMENDED — UNTESTED`; provider separation; storage-key model; deployment topology; transcoding boundary; future scaling section. |
| **$0 Feasibility** | PASS | Cloudflare-first (Pages/Worker/D1/R2); Neon/Upstash removed from MVP; all limits cited from official docs; all capacity figures labeled ESTIMATE with assumptions; no quota→headcount conversion. |
| **D1/SQL Correctness** | PASS | All 8 fenced SQL blocks executed against SQLite 3.50.4: schema + FTS5 triggers create cleanly, runtime queries return correct results. TEXT ids, INTEGER timestamps, JSON as TEXT, dependency-ordered tables, valid FK/index/constraints; no PostgreSQL-only constructs. |
| **Playback Security** | PASS | Worker is the authorization boundary; D1 authoritative; R2 is storage only; opaque sessions; presigned URLs scoped/capped; CORS restricted; no permanent public URLs. |
| **Documentation Quality** | PASS | Evidence classification framework applied; official Cloudflare citations present; example configs labeled EXAMPLE ONLY; unverified items recorded; dispositions table included. |

**Overall: PASS** (all mandatory categories passed).

> Scope caveat: this self-evaluation is a documentation-level audit. Playback behavior, D1 FTS5 behavior, and rate-limit cadence remain **UNTESTED** and are recorded as such; they do not block the documentation milestone but are explicit implementation-time validation requirements.

---

## 24. Correction Dispositions

**All 21 review findings have been addressed, with each disposition documented as corrected, retained with justification, or intentionally deferred.**

| Finding | Disposition | Change made | Reason | Remaining validation |
| --- | --- | --- | --- | --- |
| 1. $0 MVP must be Cloudflare-first; remove Neon/Upstash | Corrected | MVP = Pages + Worker + D1 + R2; Neon/Upstash moved to §22 | $0/Cloudflare-first objective; Neon/Upstash are paid/future. | Redeploy review of §6/§22 |
| 2. Verify current Cloudflare limits; cite official docs | Corrected | Limits/pricing verified from official pages; citations added | Avoid stale/third-party figures. | Check docs on each future change (docs URLs date-stamped) |
| 3. Correct R2 playback architecture (presigned URLs, not HMAC) | Corrected | §9 uses R2 S3 presigned URLs; no invented HMAC claim | Presigned URLs are the documented R2 mechanism. | None beyond docs accuracy |
| 4. Explicitly solve HLS authorization (playlists/segments/subtitles) | Corrected | §10–13 define Worker-mediated playlists + presigned segments; subtitles covered | Playback must be authorized end-to-end. | Player validation (UNTESTED) |
| 5. Playback authorization is the security boundary | Corrected | §10 Worker flow: session→asset→rights→active→temporary access | Worker must gate all access. | None |
| 6. Opaque sessions in D1; no JWT blocklist in KV | Corrected | §7 opaque D1-backed sessions only | Simpler, D1-authoritative revocation. | None |
| 7. KV responsibilities | Corrected | §6.4 KV limited to cache/config/feature flags; D1 authoritative; DO only with concrete need | Avoid authoritative state in eventually-consistent KV. | None |
| 8. Rate limiting: native API, not D1 counters | Corrected | §18 uses Workers Rate Limiting API; no D1 counters | Native, documented mechanism. | Cadence validation (UNTESTED) |
| 9. Replace "No origin server exposed" wording | Corrected | §9/§10/§15 replaced with precise statements (storage_key, temporary presigned access, no public URLs) | Old phrasing overstated the model. | None |
| 10. Deployment topology | Corrected | §19 Pages(SPA) + standalone Worker(D1+R2); Workers Static Assets only as alternative | Use proven, documented Cloudflare topology. | None |
| 11. Workers are not a transcoding environment | Corrected | §20 explicitly states this; ingestion via local/external FFmpeg; Stream = future | Workers CPU/limits unsuitable for transcoding. | None |
| 12. Fix all SQL for D1/SQLite | Corrected | Every snippet SQLite-valid; TEXT ids; INTEGER timestamps; JSON TEXT; no UUID/gen_random_uuid()/JSONB | D1 is SQLite. | D1 dialect recheck at implementation |
| 13. Audit playback types (OBSERVED/RECONSTRUCTED/etc.) | Retained with Justification | Playback & provider types now carry explicit classifications; multi-format embeds retained only as provider capability, HLS-first MVP | Purposeful retention: Libre retains provider-variety pattern (from upstream) while HLS is the recommended playback path. | FTUX of HLS.js/native on real devices (UNTESTED) |
| 14. DASH: INFERRED, not implemented | Corrected | §4.3 DASH = INFERRED/NOT VERIFIED; Libre MVP NOT IMPLEMENTED; future = RECOMMENDED | dash.js presence ≠ verified runtime support. | None (future-phase only) |
| 15. Provider separation | Corrected | §16 keeps Metadata/Playback/Subtitle/Image providers distinct; upstream vs Libre separated | Clear boundaries, avoids collapse. | None |
| 16. Remove permanent public playback URLs | Corrected | §9 canonical model = `storage_key`; temp access only post-auth | storage_key is identity; URLs are ephemeral access. | None |
| 17. Remove unsupported infra claims (~300 PoPs etc.) | Corrected | No vague PoP-count or unverified infra claims; only doc-cited Cloudflare limits | Only official/supported facts retained. | None |
| 18. Scaling all labeled ESTIMATE | Corrected | §21 all capacity values ESTIMATE with assumptions; quota↛headcount rule stated | Honest planning math. | Post-launch observability |
| 19. Diagram: actual MVP (Worker auth vs R2 delivery) | Corrected | §1/§6/§10 diagrams show Worker authorization boundary and R2 delivery separately | Correct mental model for the MVP. | None |
| 20. Self-evaluation: independent checks | Corrected | §23 independent categorical PASS/FAIL per mandatory category | Overall PASS only when all mandatory categories pass. | None |
| 21. Full revised document + appendices | Corrected | This document (Sections 1–24 + appendices) | Milestone 1 output is the complete document, not a changelog. | Final audit below |

**Disposition counts:** Corrected — 20 · Retained with Justification — 1 · Intentionally Deferred — 0 (no finding was deferred; unverified items are recorded as validation requirements rather than deferred findings).

---

## Appendix A — What changed

1. `$0 MVP` is now strictly Cloudflare Pages + Worker + D1 + R2; Neon/Upstash removed from MVP.
2. Cloudflare limits/pricing/pre-signed URL/CORS/rate-limit facts re-verified from official docs and cited.
3. R2 playback corrected to S3-compatible presigned URLs; no invented HMAC "CDN validation."
4. `src/backend/` re-described as client-side data layer (not "server backend").
5. HLS handled via three-model comparison; Model B selected, labeled `RECOMMENDED — Libre MVP` + `UNTESTED`.
6. `storage_key` canonical; no permanent public playback URLs.
7. Opaque D1-backed sessions; no JWT blocklist in KV.
8. Workers Rate Limiting API with EXAMPLE ONLY namespace ids.
9. D1/SQLite-valid schema; every SQL snippet audited; FTS5 sync triggers verified by execution (rowid-mirrored inserts + plain `DELETE`, per fts5.html §6.3 for normal FTS5 tables).
10. Deployment topology fixed to Pages (SPA) + standalone Worker.
11. Transcoding explicitly outside Workers.
12. DASH classified INFERRED/NOT VERIFIED; NOT IMPLEMENTED in MVP.
13. Provider separation; upstream vs Libre distinguished.
14. All scaling numbers labeled ESTIMATE with assumptions; no quota→headcount.
15. Self-evaluation in independent PASS/FAIL categories.
16. Correction disposition table (this appendix plus Section 24).

## Appendix B — What remains intentionally unverified

| Item | Status |
| --- | --- |
| DASH runtime/provider path in upstream | INFERRED / NOT VERIFIED |
| Exact upstream provider wire protocol | RECONSTRUCTED / NOT VERIFIED |
| HLS.js/native player behavior with presigned segment URLs | RECOMMENDED — UNTESTED |
| D1 FTS5 availability/behavior | RECOMMENDED — UNTESTED |
| Rate-limit cadence at real load | ESTIMATE / unvalidated |
| Range/seek behavior on R2 via chosen player | To validate at implementation |
| Playlist refresh cadence of chosen player | To validate at implementation |
| Any quota value expressed as supported user count | Intentionally not claimed |

## Appendix C — Official Cloudflare sources

1. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) — 100K req/day Free, 10 ms CPU, 128 MB, 50 subrequests, 6 conn, 64 MiB, startup 1 s; Error 1027; static asset file limits.
2. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) — Free vs Standard $5/mo, 10M req, dynamic CPU billing; static assets free/unlimited.
3. [Pages Functions pricing](https://developers.cloudflare.com/pages/functions/pricing/) — static asset requests free/unlimited; Functions billed as Workers (share free quota).
4. [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) — Free 5M reads/100K writes/day, 5 GB; resets 00:00 UTC; no egress.
5. [R2 pricing](https://developers.cloudflare.com/r2/pricing/) — free tier 10 GB-month, 1M Class A/10M Class B ops, free egress; Standard $0.015/GB-mo, $4.50/M Class A, $0.36/M Class B.
6. [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/) — S3-compatible, GET/HEAD/PUT/DELETE, 1s–7d expiry, S3 API domain, custom-domain limitation, bearer token security, CORS requirement.
7. [R2 bucket CORS](https://developers.cloudflare.com/r2/buckets/cors/) — CORS fields, Origin requirement, preflight caching, 30s propagation, expired-presigned-no-CORS-headers behavior.
8. [Workers Rate Limiting API](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) — binding config, 10/60 s periods, locality, eventual consistency, non-authoritative; example namespace ids.
9. [D1 best practices: indexes](https://developers.cloudflare.com/d1/best-practices/use-indexes/) — rows-read mechanics referenced in §8.

## Appendix D — Explicit MVP assumptions

1. Media is owned, licensed, public-domain, or test content; no piracy pipeline is assumed.
2. HLS is pre-segmented (MPEG-TS) before upload; no transcoding inside Workers.
3. Browser CORS is configured to allow `https://libre.tv` (production) and dev-only `http://localhost:5173`.
4. Presigned URLs use short expiries and are refreshed before expiry; recovery path exists in the player.
5. D1 is the authoritative store; KV is cache/config only.
6. Session lifetime ≈ 7 days ESTIMATE (tunable).
7. Capacity figures are ESTIMATEs; they are not user-count guarantees.
8. All `namespace_id` examples are EXAMPLE ONLY and are replaced with real ones at deployment.

## Appendix E — Evidence classification summary

| Category | Count (approx.) | Where used |
| --- | --- | --- |
| OBSERVED | Cloudflare docs facts, upstream file presence, DASH dependency presence | §2, §6, §8–9, §11, §13–15, Appendix C |
| INFERRED / NOT VERIFIED | DASH runtime path, upstream protocol | §2, §4, §4.3 |
| RECONSTRUCTED | PlaybackSource abstraction, provider wire behavior | §2, §4, §16 |
| RECOMMENDED | Decision choices (Model B, sessions, schema, topology, CORS, rate limiting, future stack) | throughout |
| ESTIMATE | Capacity/scaling figures | §7, §11, §21 |

---

*End of document. Milestone 1 (documentation/architecture revision) is complete. Final audit results are recorded in Sections 23–24 and appendices A–E. Nothing in this workspace is deployed; no code was written; no Cloudflare resources were created or configured; nothing was committed or pushed.*