// Libre — shared API contract between the Worker (api.libre.tv) and the SPA (libre.tv).
// Type-only module: import with `import type`. Keep in sync with ARCHITECTURE.md §5/§7/§10/§12.

export const API_VERSION = "v1";

/** Uniform JSON error envelope: { error: { code, message } } (ARCHITECTURE.md §API contract). */
export interface ApiErrorEnvelope {
  error: { code: string; message: string };
}

export interface HealthPayload {
  status: "ok";
  service: string;
  ts: number;
}

// ---- auth (§7) ----
export interface LoginRequest {
  email: string;
  password: string;
}

export interface SessionUser {
  id: string;
  email: string;
  display_name: string | null;
  is_admin: boolean;
}

export interface SessionPayload {
  authenticated: boolean;
  user: SessionUser | null;
  expires_at: number | null;
}

// ---- media / catalog ----
export type MediaType = "hls" | "mp4" | "image" | "subtitle";

export interface MediaListItem {
  /** Top-level catalog entity for listing (series or episode-backed entry). */
  id: string;
  title: string;
  overview: string | null;
  type: "series" | "episode";
  poster_key: string | null;
  /** Backdrop/fanart URL from series metadata_json (may be null). */
  fanart_key: string | null;
  /** Official title treatment (transparent PNG) from metadata_json, if any. */
  logo_key: string | null;
  /** Content kind from series metadata_json: movie | tv | anime | series. */
  kind: string;
  /** Ranking/genre metadata (null/absent when the importer didn't provide it). */
  score: number | null;
  popularity: number | null;
  genres: string[];
  format: string | null;
  /** Release/first-air year (null when unknown). */
  year: number | null;
  /** First playable asset id, if authorized for the current session. */
  playable: boolean;
}

export interface EpisodeSummary {
  id: string;
  episode_num: number;
  title: string;
  overview: string | null;
  release_date: string | null;
  runtime_minutes: number | null;
  /** Episode still image URL (importer-provided), if any. */
  still_key: string | null;
}

export interface SeasonSummary {
  id: string;
  season_num: number;
  episodes: EpisodeSummary[];
}

export interface MediaDetail {
  id: string;
  name: string;
  overview: string | null;
  poster_key: string | null;
  fanart_key: string | null;
  /** Official title treatment (transparent PNG), if the importer found one. */
  logo_key: string | null;
  tagline: string | null;
  /** Release year (movies) or first-air year (series). */
  year: number | null;
  runtime_minutes: number | null;
  imdb_id: string | null;
  score: number | null;
  genres: string[];
  kind: string;
  /** TMDB id for TMDB deep links (reviews list); null for non-TMDB rows. */
  tmdb_id: number | null;
  /** Watch-page URL (/watch/<kind>/<id>); always present. */
  watch_url: string;
  cast: CastMember[];
  reviews: TitleReview[];
  review_count: number;
  similar: MediaListItem[];
  trailer: TitleTrailer | null;
  seasons: SeasonSummary[];
  /** Playable-asset ids per episode (authorized subset for this session). */
  playable_assets_by_episode: Record<string, string[]>;
  limitations: {
    /** Reasons an episode is NOT playable for the current session. */
    reasons_by_episode: Record<string, string[]>;
  };
}

/** Top-billed cast entry for a title. */
export interface CastMember {
  person_id: string;
  /** Numeric TMDB id for clean /person/<id> links (null for legacy rows). */
  tmdb_id: number | null;
  name: string;
  /** TMDB profile path ("/abc.jpg") or null — client prefixes the image host. */
  photo_path: string | null;
  character: string | null;
}

/** Excerpt from a TMDB member review. */
export interface TitleReview {
  author: string;
  rating: number | null;
  content: string;
  created_at: string | null;
  /** TMDB review id for the /review/<id> page (null when unknown). */
  tmdb_review_id: string | null;
}

/** Trailer pick for a title (YouTube only). */
export interface TitleTrailer {
  site: "YouTube";
  key: string;
  kind: string;
  name: string | null;
}

/** Person detail for /person pages. */
export interface PersonDetail {
  id: string;
  /** Numeric TMDB id for clean /person/<id> links (null for legacy rows). */
  tmdb_id: number | null;
  name: string;
  photo_path: string | null;
  department: string | null;
  birthday: string | null;
  birthplace: string | null;
  bio: string | null;
  imdb_id: string | null;
  /** Up to 3 best-known credit titles (by catalog popularity). */
  known_for: string[];
  credits: PersonCredit[];
  /** People who share the most titles with this person (max 6). */
  collaborators: PersonCollaborator[];
}

/** A frequent co-star / collaborator, derived from shared catalog titles. */
export interface PersonCollaborator {
  id: string;
  tmdb_id: number | null;
  name: string;
  photo_path: string | null;
  department: string | null;
  shared: number;
  shows: number;
  films: number;
}

/** One filmography entry on a person page. */
export interface PersonCredit {
  series_id: string;
  title: string;
  poster_key: string | null;
  year: number | null;
  score: number | null;
  popularity: number | null;
  kind: string;
  character: string | null;
}

export interface SearchResultItem {
  media_id: string;
  type: "series" | "episode" | "person";
  title: string;
  overview: string | null;
  /** TMDB profile path for person results (null otherwise). */
  photo_path: string | null;
  /** Series poster for title results (null for people). */
  poster_key: string | null;
  year: number | null;
  score: number | null;
}

export interface SearchPayload {
  query: string;
  results: SearchResultItem[];
}

// ---- bookmarks (§8) ----
export interface BookmarkItem {
  episode_id: string;
  episode_title: string;
  release_date: string | null;
  series_id: string;
  series_name: string;
}

export interface BookmarksPayload {
  bookmarks: BookmarkItem[];
}

// ---- subtitles (§8) ----
export interface SubtitleTrack {
  id: string;
  language: string;
  is_default: boolean;
}

export interface SubtitlesPayload {
  episode_id: string;
  subtitles: SubtitleTrack[];
}

// ---- watch resolver ----
export interface ResolvePayload {
  series_id: string;
}

// ---- live TV (official free streams) ----
export interface LiveChannel {
  id: string;
  name: string;
  category: string;
  youtube_channel_id: string;
}

// ---- watch parties ----
export interface PartyCreatePayload {
  code: string;
  episode_id: string;
  room_name: string | null;
}

export interface PartyInfoPayload {
  code: string;
  room_name: string | null;
  episode_id: string;
  episode_title: string | null;
  series_name: string | null;
  host_name: string;
  active: boolean;
  member_count: number;
  state: { position: number; playing: boolean; by: string; at: number };
}

// ---- playback (§10/§12) ----
export interface PlaybackError {
  code: "no_session" | "no_rights" | "not_found" | "disabled" | "inactive";
}

// ---- R2 presign metadata (used by ingest for D1 asset recording) ----
export interface AssetRendition {
  rendition: string | null;
  container: string | null;
  byte_size: number | null;
  duration_seconds: number | null;
}

export interface AssetRecord {
  id: string;
  episode_id: string;
  storage_key: string;
  media_type: MediaType;
  rendition: string | null;
  container: string | null;
  codecs_json: Record<string, unknown> | null;
  byte_size: number | null;
  duration_seconds: number | null;
}