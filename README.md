# Libre

A self-hosted, Cloudflare-first streaming app for **your own licensed media**. Movies, shows and anime metadata come from TMDB/AniList; video is transcoded to HLS and served from a private R2 bucket through a Worker that checks entitlements before issuing short-lived URLs.

No scraping, no piracy sources, no ads. Live TV uses official broadcaster YouTube embeds.

## Architecture

```
libretv-web (React SPA, Cloudflare Pages)  ──►  worker (Cloudflare Worker API)
                                                   ├── D1  — users, sessions, catalog, rights, progress
                                                   ├── R2  — private HLS media + subtitles
                                                   └── Durable Object — watch-party rooms
```

See `ARCHITECTURE.md` for the design rationale and `IMPLEMENTATION_MAP.md` for the original milestone plan.

## Quick start

```bash
npm install
npm run dev:worker    # API  → http://localhost:8787  (local D1 + R2 via Miniflare)
npm run dev:web       # SPA  → http://localhost:5173
```

The local Worker uses `worker/.dev.vars` and persisted state in `worker/.wrangler/`. To reset your local database:

```bash
npm run migrate:local -w worker
npm run seed:local -w worker
```

`libretv-web/.env.local` already points the SPA at the local Worker.

## Populate the catalog

Requires a free TMDB v3 key in the root `.env` (`TMDB_API_KEY`). AniList needs no key.

```bash
node scripts/import-tmdb.mjs
node scripts/import-anilist.mjs
node scripts/enrich-titles.mjs     # cast, reviews, recommendations
node scripts/subs-opensubtitles.mjs
```

## Add media

`ingest/` probes a local video with ffprobe, builds a 720p/480p ABR ladder with ffmpeg, validates the HLS output, uploads it to R2 and registers an asset in D1.

```bash
cd ingest
./ingest.sh --help        # or ./ingest.ps1 --help on Windows
```

## Subtitles (OpenSubtitles)

Subtitles are imported into D1 ahead of time, not fetched from the browser. Add a free OpenSubtitles API key to the root `.env`:

```dotenv
OS_API_KEY=your-key
OS_USERNAME=your-username
OS_PASSWORD=your-password
```

Then fetch tracks for an episode (the wrapper loads `.env` for you):

```bash
npm run subs -- --episode ep_bbb_01 --tmdb-id 10378 --languages en,es --out-dir ./subs
```

The script writes `subs/<episode>.<lang>.srt` files plus `subs.sql`. Upload the files and apply the SQL locally (or to your Worker):

```bash
npx wrangler r2 object put libre-media/media/subs/<episode>.<lang>.srt --file subs/<episode>.<lang>.srt --local
npx wrangler d1 execute libre-db --local --file=subs.sql
```

The player lists any imported tracks automatically in its subtitles panel.

## Quality checks

```bash
npm test        # Worker unit + integration tests
npm run build   # Worker dry-run deploy + SPA production build
npm run lint -w libretv-web
```

An end-to-end smoke test lives in `e2e/` (login → search → open title → player → HLS master).

## Deployment notes

- `worker/wrangler.production.toml` is interim: the **R2 binding is omitted**, so playback returns an error until a bucket is configured.
- Rate-limit namespaces are commented out in `wrangler.toml`; the Worker degrades gracefully without them.
- The SPA is served from `*.pages.dev` pending DNS for `libre.tv`. Set `VITE_API_URL` at build time to the deployed Worker origin.
