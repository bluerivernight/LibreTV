# Libre — Milestone 2 Implementation Map

> Map from each ARCHITECTURE.md requirement to existing state → required artifacts → tests.
> Following the mandated priority order: foundation → Worker/API → D1 → auth → R2 → playback auth → HLS slice → player → CORS → rate limiting → frontend slice.

Status legend: ⬜ not started · ◑ in progress · ✅ done

> **2026-11-20 update:** the table below is the original planning snapshot and its status cells were never filled in. In practice the roadmap has been implemented: the Worker/API, D1 migrations, auth, R2 ingest, playback authorization, HLS player, CORS, frontend and E2E smoke test all exist in the repo. Cloudflare **rate-limit bindings are still commented out** and the **production R2 binding is intentionally omitted** (`worker/wrangler.production.toml`), so those rows remain genuinely open. Use `npm test` and `npm run build` as the current definition of done.

## Priority 1 — Project foundation

| ARCHITECTURE.md requirement | Existing | Required | Tests |
| --- | --- | --- | --- |
| §1/$0 MVP environment (no paid services) | Only `ARCHITECTURE.md` present | `package.json` (npm workspaces: `worker`, `frontend`, `e2e`), `.gitignore`, shared TS types | `npm install` resolves |
| Worker runtime (TS, Free plan) | — | `worker/package.json`, `worker/tsconfig.json`, `worker/wrangler.toml`, `worker/.dev.vars.example` | `tsc --noEmit` |
| Worker size ≤ 64 MiB, no node_compat gamble | — | Pure fetch-based Worker, WebCrypto (no AWS SDK, no node APIs) | bundle check via `wrangler deploy --dry-run` |
| Test tooling | Python 3.14.7/sqilte3, Node 24, ffmpeg 9 | root deps: `typescript`, `wrangler`, `vitest`, `@cloudflare/vitest-pool-workers` | — |

## Priority 2 — Worker / API foundation

| Requirement | Existing | Required | Tests |
| --- | --- | --- | --- |
| §5 API surface on Worker | — | `worker/src/index.ts` (entry), `worker/src/router.ts` (native fetch router), `worker/src/env.ts` (`Env` bindings) | unit: router dispatch, 404, method mismatch |
| CORS (§14) | — | `worker/src/util/cors.ts` (ALLOWED_ORIGINS env, preflight OPTIONS, credentials) | unit: origin allow/deny, preflight |
| JSON/error contract | — | `worker/src/util/http.ts` (json, error envelope `{error:{code,message}}`) | unit |
| `GET /api/health` (mandated) | — | `worker/src/routes/health.ts` (+ `/api/v1/health` alias) | integration: `{status:"ok", service, ts}` |

## Priority 3 — D1

| Requirement | Existing | Required | Tests |
| --- | --- | --- | --- |
| §8.1 schema (exact, SQLite-valid) | — | `worker/migrations/0001_init.sql` — all 8 tables in dependency order, indexes, UNIQUE/PK/FK | DB-level: create in miniflare D1; idempotent re-run |
| §8.2 FTS5 + triggers (rowid-mirrored, plain DELETE) | — | `episode_fts` virtual table + `episode_ai/ad/au` triggers | DB-level: insert/update/delete sync, MATCH query |
| §8.3 representative queries | — | re-expressed as prepared statements in route modules | covered per-route integration tests |
| Seed/demo data for vertical slice | — | `worker/tests/fixtures/seed.sql` (demo user, catalog, rights) | DB-level: seed applies, FKs valid |

## Priority 4 — Auth

| Requirement | Existing | Required | Tests |
| --- | --- | --- | --- |
| §7.1 opaque D1-backed sessions, no JWT/KV | — | `worker/src/util/passwords.ts` (PBKDF2-SHA256, WebCrypto, `pbkdf2$iter$salt$hash`, timing-safe verify) | unit: hash/verify, mismatch, format |
| §7.1 32-byte random session token, sha256 at rest | — | `worker/src/util/sessions.ts` (token gen, cookie serialize/parse) | unit: entropy, hashing, cookie attrs Secure/HttpOnly/SameSite |
| §7.2 `POST /api/auth/login` (mandated) | — | `worker/src/routes/auth.ts` | integration: success sets cookie, bad creds 401, inactive user 403 |
| §7.2 `POST /api/auth/logout` (mandated) | — | revoke row, clear cookie | integration: revokes only that session |
| §7.1/7.2 `GET /api/auth/session` (mandated) | — | lookup + hydration | integration: valid/invalid/expired/revoked |
| `POST /api/auth/refresh`, registration (optional) | — | registration + refresh endpoints (MVP) | integration |

## Priority 5 — R2

| Requirement | Existing | Required | Tests |
| --- | --- | --- | --- |
| §9.2 SigV4 presigned URLs (GET/HEAD, 1s–7d, S3 API domain) | — | `worker/src/util/presign.ts` (hand-rolled SigV4, WebCrypto HMAC; `awsAccessKeyId`, no payload signing for GET/HEAD) | unit: deterministic signature, expiry param, path/query encoding |
| §9.1 object layout `media/<assetId>/...` | — | ingest pipeline (Priority 9) uploads to this layout | fixture on-disk layout matches |
| §15 private bucket, S3 API only | — | `wrangler.toml` `[[r2_buckets]]`, no public bucket | config review |
| Env/secrets | — | `.dev.vars.example` (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY) | — |

## Priority 6 — Playback authorization

| Requirement | Existing | Required | Tests |
| --- | --- | --- | --- |
| §10.1 Worker is the authorization boundary | — | `worker/src/routes/playback.ts` — session → asset enabled → rights → active → presign | integration: 401 no session; 403 no rights; 404 unknown/disabled; 200 with signed URLs |
| §8.3 rights check (global `user_id IS NULL` + per-user, expiry) | — | prepared statement | integration |
| §10.2 no permanent public URL; temp access only | — | only presigned R2 URLs emitted post-auth | integration: response contains only `r2.cloudflarestorage.com` signed URLs |
| `GET /api/playback/:assetId` (mandated) | — | alias to master playlist | integration |
| `GET /api/v1/playback/:assetId` (top-level mandate) | — | `/api/*` + `/api/v1/*` dual mount | integration |

## Priority 7 — HLS vertical slice (Model B)

| Requirement | Existing | Required | Tests |
| --- | --- | --- | --- |
| §12.2 master playlist served by Worker | — | `GET /api/playback/master/:assetId` — R2 `master.m3u8`, variant URIs rewritten to Worker endpoint | unit: URI rewrite; integration: auth + content-type |
| §12.2 media playlist rewritten with presigned segments | — | `GET /api/playback/media/:assetId?var=<rend>` — R2 `<rend>/playlist.m3u8`, segment lines → presigned absolute URLs | unit: playlist rewrite (tags preserved, only URI lines signed); integration |
| §13 refresh-before-expiry | — | presign expiry const (e.g. 30 min) > playlist refresh cadence; re-fetch re-authorizes | unit: expiry set; integration: second fetch re-signs |
| Real playable slice | — | fixture HLS (ffmpeg-generated short clip, ABR ladder) in `worker/tests/fixtures/media/`; ingested into miniflare R2 in tests | DB/integration: object availability + playlist correctness |

## Priority 8 — Player layer

| Requirement | Existing | Required | Tests |
| --- | --- | --- | --- |
| §12.1 native HLS + HLS.js fallback | — | `frontend/src/components/Player.tsx` (dynamic-import hls.js; native when `canPlayType` supports) | build-time + E2E |
| §13 recovery after expired credentials (403 no-CORS) | — | player: on fetch/segment 403 → re-fetch media playlist through Worker | unit (pure helper) + E2E note |

## Priority 9 — Ingestion (HLS/ABR → R2)

| Requirement | Existing | Required | Tests |
| --- | --- | --- | --- |
| §20 local/external FFmpeg, not Workers | ffmpeg 9.0 present | `ingest/ingest.sh` — transcode → ABR ladder (`media/<id>/master.m3u8`, `<rend>/playlist.m3u8`, `<rend>/seg0000.ts`), verify output, upload to R2 (wrangler r2 object put, dev + remote), then record asset in D1 (`storage_key`) | dry-run/verified output parses as HLS |
| §9.1 storage_key canonical | — | `storage_key` = `media/<assetId>/{master.m3u8,<rend>/playlist.m3u8,...}`; parent asset row inserted by ingest | ingest — list-objects matches layout |

## Priority 10 — CORS

| Requirement | Existing | Required | Tests |
| --- | --- | --- | --- |
| §14 R2 bucket CORS (prod `https://libre.tv`, dev `http://localhost:5173`) | — | `r2-cors.json` + `scripts/set-r2-cors.mjs` (`wrangler r2 bucket cors`) | script smoke (documented need for real bucket creds) |
| §14 Worker API CORS (same origins) | — | env-driven in `cors.ts` | unit |

## Priority 11 — Rate limiting

| Requirement | Existing | Required | Tests |
| --- | --- | --- | --- |
| §18.1 Workers Rate Limiting API; no D1 counters | — | `[[ratelimits]]` in `wrangler.toml` (AUTH_LIMITER, API_LIMITER, PLAYBACK_LIMITER), `namespace_id` from env vars (not hardcoded fakes), `limit({key})` calls in routes; graceful skip if binding absent | unit: key selection per route; integration: 429 when over limit (fake binding) |
| §18.2 EXAMPLE-only ids; real ids at deploy | — | default placeholder namespace ids commented/validated as EXAMPLE ONLY | config review |

## Priority 12 — Frontend vertical slice

| Requirement | Existing | Required | Tests |
| --- | --- | --- | --- |
| §5 Pages SPA (React/Vite) | — | `frontend/` Vite+React+TS scaffold, `vite.config.ts` (`/api` proxy → worker in dev, `ALLOWED_ORIGINS` includes dev) | `vite build` |
| Home → media list | — | `pages/Home.tsx` (GET /api/media) | component + E2E |
| Detail (+ limitations) | — | `pages/Detail.tsx` (GET /api/media/:id; rights/limitations surfaced) | component + E2E |
| Login/session | — | `pages/Login.tsx`, `session.tsx` context (GET /api/auth/session, POST login/logout) | component + E2E |
| Watch/Play | — | `pages/Watch.tsx` + `components/Player.tsx` | E2E: login → play fixture HLS |

## Priority 13 — E2E / browser

| Requirement | Existing | Required | Tests |
| --- | --- | --- | --- |
| browser/E2E | Playwright-as-devDep (no browser yet) | `e2e/playwright.config.ts`, `e2e/smoke.spec.ts` (worker `wrangler dev` + vite preview + seeded D1/R2) | `playwright test` |

## DoD gate
- foundation builds (`tsc`, `vite build`, `wrangler deploy --dry-run`)
- auth works (login→session→logout integration pass)
- authorization enforced (playback 401/403/404 matrix passes)
- HLS horizontal slice actually plays (miniflare R2 + D1 integration + E2E)
- all unit/db/integration tests pass; E2E scaffolded (browser download documented)
- no paid services, no architectural revisions, evidence labels honored, FTS5 & rate-limit cadence remain `RECOMMENDED — UNTESTED` on real infra with explicit notes