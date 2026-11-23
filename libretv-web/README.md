# Libre web app

React 19 + TypeScript + Vite SPA for Libre. It talks to the Worker API in `../worker` and has no backend of its own.

## Run locally

```bash
npm install          # from the repository root (npm workspaces)
npm run dev:worker   # terminal 1 — API at http://localhost:8787
npm run dev:web      # terminal 2 — SPA at http://localhost:5173
```

`libretv-web/.env.local` points the SPA at `VITE_API_URL=http://localhost:8787`. The Worker's `ALLOWED_ORIGINS` must include the web origin, or CORS will block requests.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server with HMR |
| `npm run build` | Type-check and produce `dist/` |
| `npm run lint` | Oxlint |
| `npm run preview` | Serve the built `dist/` |

## Structure

- `src/App.tsx` — routes and all views (home, browse, search, title, person, watch, library, account, settings, live, TV lean-back, watch parties).
- `src/components/VideoPlayer.tsx` — hls.js player with a custom chrome, quality/audio/subtitle/speed panels, PiP, fullscreen and a keyboard-shortcut help overlay (`?`).
- `src/lib/api.ts` — typed API client. `VITE_API_URL` sets the Worker origin; `VITE_API_BASE` is the same-origin fallback.
- `src/stores/playerStore.ts` — Zustand player state.
- `src/index.css`, `src/App.css` — design tokens and component styles. Theme is selected in Settings and stored in `localStorage["libre:theme"]` (`system` / `light` / `dark`).
- `public/` — favicon, PWA manifest, generated icons and service worker. The service worker caches only same-origin static assets; API traffic is never cached.

## Notes

The catalog is empty until you import metadata (see the root README and `scripts/`). Playback requires media uploaded to R2 by `ingest/`.
