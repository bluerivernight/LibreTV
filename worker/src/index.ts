// Libre — API Worker entry point (§5 / §19).
// §5: pure Cloudflare Worker, native fetch. No Node.js runtime; no node_compat.
// §19: standalone Worker on api.libre.tv → D1 + R2.
// §18: graceful rate-limit degradation when binding is absent (tests/local without namespace).

import type { Env } from "./env";
import { createRouter, param, searchParam } from "./router";
import { handleCorsPreflight, addCorsHeaders } from "./util/cors";
import { handleHealth } from "./routes/health";
import { handleLogin, handleLogout, handleSession, handleRefresh, handleRegister } from "./routes/auth";
import { handleMediaList, handleMediaDetail } from "./routes/media";
import { handleResolve } from "./routes/resolve";
import { handleLiveList } from "./routes/live";
import { handlePersonDetail } from "./routes/people";
import { handleSearch } from "./routes/search";
import { handleBookmarksList, handleBookmarkAdd, handleBookmarkRemove } from "./routes/bookmarks";
import { handleSubtitlesList, handleSubtitleFile } from "./routes/subtitles";
import { handlePartyCreate, handlePartyInfo, handlePartySocket, handlePartyTicket } from "./routes/party";

export { PartyRoom } from "./routes/party";
import { handlePlaybackMaster, handlePlaybackMedia, handleSegment } from "./routes/playback";

const router = createRouter();

// §18.1 — Workers Rate Limiting API. Binding names match wrangler.toml [[ratelimits]].
// §18: graceful degradation — handlers check `env.X_LIMITER` before calling `.limit()`.

// §5/§12 — Health
router.route("GET",  "/api/health",          handleHealth );

// §7 — Auth (unauthenticated endpoints)
router.route("POST", "/api/auth/login",      handleLogin );
router.route("POST", "/api/auth/logout",     handleLogout );
router.route("GET",  "/api/auth/session",    handleSession );
router.route("POST", "/api/auth/refresh",    handleRefresh );
router.route("POST", "/api/auth/register",   handleRegister );

// §5 — Catalog (authenticated, optional)
router.route("GET",  "/api/media",           handleMediaList );
router.route("GET",  "/api/media/:id",       handleMediaDetail );
router.route("GET",  "/api/people/:id",      handlePersonDetail );
router.route("GET",  "/api/resolve/:kind/:id", handleResolve );
router.route("GET",  "/api/live",            handleLiveList );

// §17 — Search
router.route("GET",  "/api/search",          handleSearch );

// §8 — Bookmarks (per-user, session required)
router.route("GET",    "/api/bookmarks",      handleBookmarksList );
router.route("POST",   "/api/bookmarks",      handleBookmarkAdd );
router.route("DELETE", "/api/bookmarks/:id",  handleBookmarkRemove );

// §8 — Subtitles (list public; file bodies gated like playback)
router.route("GET", "/api/subtitles/:id",        handleSubtitlesList );
router.route("GET", "/api/subtitles/file/:id",   handleSubtitleFile );

// Watch parties (realtime rooms; 24h TTL)
router.route("POST", "/api/parties",             handlePartyCreate );
router.route("GET",  "/api/parties/:code",       handlePartyInfo );
router.route("POST", "/api/parties/:code/ticket", handlePartyTicket );
router.route("GET",  "/api/parties/:code/socket", handlePartySocket );

// §10/§12 — Playback (Model B: Worker-mediated playlists)
router.route("GET",  "/api/playback/master/:id", handlePlaybackMaster );
router.route("GET",  "/api/playback/media/:id",  handlePlaybackMedia );
router.route("GET",  "/api/playback/:id",        handlePlaybackMaster ); // §mandate alias
router.route("GET",  "/api/segments/:id",      handleSegment );

// §v1 — API versioned aliases (top-level mandate: `/api/v1/*`)
router.route("GET",  "/api/v1/health",          handleHealth );
router.route("POST", "/api/v1/auth/login",      handleLogin );
router.route("POST", "/api/v1/auth/logout",     handleLogout );
router.route("GET",  "/api/v1/auth/session",    handleSession );
router.route("POST", "/api/v1/auth/refresh",    handleRefresh );
router.route("POST", "/api/v1/auth/register",   handleRegister );
router.route("GET",  "/api/v1/media",           handleMediaList );
router.route("GET",  "/api/v1/media/:id",       handleMediaDetail );
router.route("GET",  "/api/v1/people/:id",      handlePersonDetail );
router.route("GET",  "/api/v1/resolve/:kind/:id", handleResolve );
router.route("GET",  "/api/v1/live",            handleLiveList );
router.route("GET",  "/api/v1/search",          handleSearch );
router.route("GET",    "/api/v1/bookmarks",      handleBookmarksList );
router.route("POST",   "/api/v1/bookmarks",      handleBookmarkAdd );
router.route("DELETE", "/api/v1/bookmarks/:id",  handleBookmarkRemove );
router.route("GET", "/api/v1/subtitles/:id",        handleSubtitlesList );
router.route("GET", "/api/v1/subtitles/file/:id",   handleSubtitleFile );
router.route("POST", "/api/v1/parties",             handlePartyCreate );
router.route("GET",  "/api/v1/parties/:code",       handlePartyInfo );
router.route("POST", "/api/v1/parties/:code/ticket", handlePartyTicket );
router.route("GET",  "/api/v1/parties/:code/socket", handlePartySocket );
router.route("GET",  "/api/v1/playback/master/:id", handlePlaybackMaster );
router.route("GET",  "/api/v1/playback/media/:id",  handlePlaybackMedia );
router.route("GET",  "/api/v1/playback/:id",        handlePlaybackMaster );
router.route("GET",  "/api/v1/segments/:id",      handleSegment );

// §14 — OPTIONS preflight handled per-route (CORS middleware wraps every response).

/** Upgrade responses (101) carry a live socket; rebuilding them would drop it.
    Detected by status only — reading `.webSocket` can throw on plain responses. */
export function isUpgradeResponse(res: Response): boolean {
  return res.status === 101;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // §14.1 — preflight must be handled before routing (OPTIONS may not match any method-routed pattern)
    const preflight = handleCorsPreflight(request, env);
    if (preflight) return preflight;

    const res = await router.handle(request, env, ctx);
    // Upgrade responses (101 + webSocket) must pass through untouched:
    // rebuilding them would drop the socket and break the handshake.
    if (isUpgradeResponse(res)) {
      return res;
    }
    return addCorsHeaders(request, res, env);
  },
} satisfies ExportedHandler<Env>;