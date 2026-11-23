import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  BookmarkItem,
  LiveChannel,
  MediaDetail,
  MediaListItem,
  PersonDetail,
  SearchResultItem,
  SessionUser,
} from "../../shared/api";
import {
  addBookmark,
  createParty,
  getMediaDetail,
  getPartyInfo,
  getPartyTicket,
  getPersonDetail,
  getSession,
  listBookmarks,
  listLive,
  listMedia,
  listSubtitles,
  login,
  logout,
  partySocketUrl,
  playbackUrl,
  register,
  removeBookmark,
  resolveWatch,
  searchMedias,
  subtitleFileUrl,
} from "./lib/api";
import VideoPlayer from "./components/VideoPlayer";
import { Artwork } from "./components/Artwork";
import { usePlayerStore } from "./stores/playerStore";
import type { PlayerSource } from "./stores/playerStore";
import "./App.css";

/** Hero backdrop photo: remote fanart only, renders nothing on failure
    (the gradient + watermark carry the design). */
function BellIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Z" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </svg>
  );
}

function HeroPhoto({ src }: { src: string | null }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed || !/^https?:\/\//.test(src)) return null;
  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      className="hero-photo"
      onError={() => setFailed(true)}
    />
  );
}

/** Official title treatment: text title shows immediately; the logo art
    replaces it the moment it finishes loading (fallback stays on failure). */
function HeroTitle({ title, logo }: { title: string; logo: string | null }) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  if (!logo || failed || !/^https?:\/\//.test(logo)) {
    return <h1 className="hero-title">{title}</h1>;
  }
  return (
    <>
      {!loaded && <h1 className="hero-title">{title}</h1>}
      <img
        src={logo}
        alt={title}
        className="hero-logo"
        style={loaded ? undefined : { display: "none" }}
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
      />
    </>
  );
}

/** Human label for a source asset id (rendition suffix) with fallback. */
function assetLabel(assetId: string, index: number): string {
  const m = /[_-](\d{3,4}p|4k|uhd|fhd|hd|sd|master)$/i.exec(assetId);
  return m ? m[1]!.toUpperCase() : `Source ${index + 1}`;
}

/** Stable hue per catalog id for generated backdrops/posters. */
function hueFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

/** Inline stroke icons (no emoji). Stroke inherits surrounding text color. */
function SideIcon({ name }: { name: string }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {name === "home" && (
        <>
          <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          <path d="M9 22V12h6v10" />
        </>
      )}
      {name === "browse" && (
        <>
          <rect x="3" y="3" width="7" height="7" rx="1" />
          <rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="14" y="14" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" />
        </>
      )}
      {name === "search" && (
        <>
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4.3-4.3" />
        </>
      )}
      {name === "continue" && (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="m10 8 6 4-6 4z" fill="currentColor" stroke="none" />
        </>
      )}
      {name === "discover" && (
        <>
          <path d="M16 3h5v5" />
          <path d="M4 20 21 3" />
          <path d="M21 16v5h-5" />
          <path d="m15 15 6 6" />
          <path d="M4 4l5 5" />
        </>
      )}
      {name === "library" && (
        <>
          <path d="m16 6 4 14" />
          <path d="M12 6v14" />
          <path d="M8 8v12" />
          <path d="M4 4v16" />
        </>
      )}
      {name === "calendar" && (
        <>
          <rect x="3" y="4" width="18" height="18" rx="2" />
          <path d="M16 2v4M8 2v4M3 10h18" />
        </>
      )}
      {name === "user" && (
        <>
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21c0-4 3.6-6 8-6s8 2 8 6" />
        </>
      )}
      {name === "tv" && (
        <>
          <rect x="2" y="7" width="20" height="14" rx="2" />
          <path d="m17 2-5 5-5-5" />
        </>
      )}
      {name === "settings" && (
        <>
          <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3" />
          <path d="M1 14h6M9 8h6M17 16h6" />
        </>
      )}
      {name === "logout" && (
        <>
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
          <path d="m16 17 5-5-5-5" />
          <path d="M21 12H9" />
        </>
      )}
      {name === "film" && (
        <>
          <rect x="2" y="4" width="20" height="16" rx="2" />
          <path d="M7 4v16M17 4v16M2 9h5M2 15h5M17 9h5M17 15h5" />
        </>
      )}
      {name === "monitor" && (
        <>
          <rect x="2" y="3" width="20" height="14" rx="2" />
          <path d="M8 21h8M12 17v4" />
        </>
      )}
      {name === "sparkles" && (
        <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
      )}
      {name === "broadcast" && (
        <>
          <circle cx="12" cy="12" r="2" />
          <path d="M7.5 7.5a6.4 6.4 0 0 0 0 9M16.5 7.5a6.4 6.4 0 0 1 0 9" />
          <path d="M4.6 4.6a10.5 10.5 0 0 0 0 14.8M19.4 4.6a10.5 10.5 0 0 1 0 14.8" />
        </>
      )}
      {name === "zap" && <path d="M13 2 3 14h7l-1 8 10-12h-7z" />}
      {name === "users" && (
        <>
          <circle cx="9" cy="8" r="3.5" />
          <path d="M2.5 20c0-3.3 2.9-5 6.5-5s6.5 1.7 6.5 5" />
          <path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M17.5 15.2c2.4.7 4 2.2 4 4.8" />
        </>
      )}
      {name === "flame" && (
        <path d="M12 22c-2.8 0-5-2-5-4.5 0-2.8 2.6-4.6 3.4-7.2.5 1.2 1 2 2.1 2.7-.3-2.4.2-4.9 1.5-7 2.6 2.6 5.5 5.7 5.5 9.5 0 3.6-3.1 6.5-7.5 6.5Z" />
      )}
      {name === "star" && (
        <path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z" />
      )}
      {name === "tag" && (
        <>
          <path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8Z" />
          <circle cx="7.5" cy="7.5" r="1.5" />
        </>
      )}
    </svg>
  );
}

interface ContinueEntry {
  assetId: string;
  title: string;
  episodeId?: string;
  position: number;
  duration: number;
  updatedAt: number;
}

const CW_KEY = "libre:continue-watching";

function readContinueWatching(): ContinueEntry[] {
  try {
    const raw = localStorage.getItem(CW_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Record<string, ContinueEntry>;
    return Object.values(parsed)
      .filter((e) => e && typeof e.position === "number" && e.position > 5)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 10);
  } catch {
    return [];
  }
}

interface LibraryViewProps {
  user: SessionUser | null;
  authChecked: boolean;
  onSignIn: () => void;
  onPlaySeriesEpisode: (seriesId: string, episodeId: string, title: string) => Promise<void>;
  onBrowse: () => void;
}

/** /library — bookmarked episodes. Sign-in required (rows are per-user). */
function LibraryView({ user, authChecked, onSignIn, onPlaySeriesEpisode, onBrowse }: LibraryViewProps) {
  const [items, setItems] = useState<BookmarkItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    listBookmarks()
      .then((rows) => {
        if (!cancelled) setItems(rows);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "library failed to load");
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  if (!authChecked) return <p className="muted">checking session…</p>;

  if (!user) {
    return (
      <section aria-label="Library" className="account-prompt" data-testid="library-signin-prompt">
        <h2>Library</h2>
        <p className="muted">Sign in to keep episodes you want to watch later.</p>
        <button type="button" className="btn-primary" onClick={onSignIn}>
          Sign in
        </button>
      </section>
    );
  }

  const play = async (item: BookmarkItem) => {
    setPlayingId(item.episode_id);
    try {
      await onPlaySeriesEpisode(item.series_id, item.episode_id, item.episode_title);
    } finally {
      setPlayingId(null);
    }
  };

  return (
    <div className="library">
      <p className="hero-kicker">Your Libre</p>
      <h2>Library</h2>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {items === null && !error && <p className="muted">loading bookmarks…</p>}
      {items !== null && items.length === 0 && (
        <div className="empty-panel">
          <p>No bookmarks yet. Open a title and press ☆ Save on any episode.</p>
          <button type="button" onClick={onBrowse}>
            Browse titles
          </button>
        </div>
      )}
      {items !== null && items.length > 0 && (
        <ul className="episode-list">
          {items.map((item) => (
            <li key={item.episode_id} className="episode-row">
              <div>
                <strong>{item.episode_title}</strong>
                <p className="muted">
                  {item.series_name}
                  {item.release_date ? ` · ${item.release_date}` : ""}
                </p>
              </div>
              <button
                type="button"
                disabled={playingId === item.episode_id}
                onClick={() => void play(item)}
                data-testid={`library-play-${item.episode_id}`}
              >
                {playingId === item.episode_id ? "…" : "Play"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface CalendarViewProps {
  catalog: MediaListItem[];
  onOpen: (seriesId: string) => void;
  onBrowse: () => void;
}

interface CalendarRow {
  episodeId: string;
  episodeTitle: string;
  releaseDate: string;
  seriesId: string;
  seriesName: string;
}

/** /calendar — episodes by release date, resolved through series details. */
function CalendarView({ catalog, onOpen, onBrowse }: CalendarViewProps) {
  const [rows, setRows] = useState<CalendarRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const all: CalendarRow[] = [];
        for (const series of catalog) {
          const detail = await getMediaDetail(series.id);
          for (const season of detail.seasons) {
            for (const ep of season.episodes) {
              if (!ep.release_date) continue;
              all.push({
                episodeId: ep.id,
                episodeTitle: ep.title,
                releaseDate: ep.release_date,
                seriesId: series.id,
                seriesName: series.title,
              });
            }
          }
        }
        all.sort((a, b) => (a.releaseDate < b.releaseDate ? 1 : -1));
        if (!cancelled) setRows(all);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "calendar failed to load");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [catalog]);

  return (
    <div className="calendar">
      <p className="hero-kicker">Your Libre</p>
      <h2>Release calendar</h2>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {rows === null && !error && <p className="muted">loading dates…</p>}
      {rows !== null && rows.length === 0 && (
        <div className="empty-panel">
          <p>No dated episodes in the catalog yet.</p>
          <button type="button" onClick={onBrowse}>
            Browse titles
          </button>
        </div>
      )}
      {rows !== null && rows.length > 0 && (
        <ul className="episode-list">
          {rows.map((row) => (
            <li key={row.episodeId} className="episode-row">
              <div>
                <strong>{row.episodeTitle}</strong>
                <p className="muted">
                  {row.seriesName} · {row.releaseDate}
                </p>
              </div>
              <button type="button" onClick={() => onOpen(row.seriesId)}>
                Open
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface TvViewProps {
  featured: MediaListItem | null;
  catalog: MediaListItem[];
  continueWatching: ContinueEntry[];
  onWatchItem: (item: MediaListItem) => void;
  onPlayEntry: (entry: ContinueEntry) => void;
  onShuffle: () => void;
  onExit: () => void;
}

interface TvRow {
  key: string;
  title: string;
  cards: Array<{ key: string; label: string; sub?: string; hue?: number; poster?: string | null; progress?: number }>;
  onPick: (index: number) => void;
}

/** /tv — lean-back mode (distinct from browser fullscreen): oversized type,
    focusable rows, full keyboard control (arrows move, Enter activates,
    Escape exits). Every control here performs its labeled action. */
function TvView({ featured, catalog, continueWatching, onWatchItem, onPlayEntry, onShuffle, onExit }: TvViewProps) {
  const [fsError, setFsError] = useState<string | null>(null);
  const [focus, setFocus] = useState({ r: 0, c: 0 });
  const btnRefs = useRef(new Map<string, HTMLButtonElement>());

  const fullScreen = useCallback(async () => {
    setFsError(null);
    try {
      await document.documentElement.requestFullscreen();
    } catch {
      setFsError("fullscreen was blocked by the browser");
    }
  }, []);

  const rows = useMemo<TvRow[]>(() => {
    const out: TvRow[] = [];
    if (continueWatching.length > 0) {
      out.push({
        key: "cw",
        title: "Continue Watching",
        cards: continueWatching.map((e) => ({
          key: e.assetId,
          label: e.title,
          sub: e.duration > 0 ? `${Math.round(e.position)}s watched` : "Resume",
          progress: e.duration > 0 ? Math.min(1, e.position / e.duration) : 0,
        })),
        onPick: (i) => {
          const e = continueWatching[i];
          if (e) onPlayEntry(e);
        },
      });
    }
    out.push({
      key: "all",
      title: "All titles",
      cards: catalog.map((c) => ({ key: c.id, label: c.title, hue: hueFor(c.id), poster: c.poster_key })),
      onPick: (i) => {
        const c = catalog[i];
        if (c) onWatchItem(c);
      },
    });
    return out;
  }, [catalog, continueWatching, onPlayEntry, onWatchItem]);

  // Keep focus inside the grid as rows change.
  const rowCount = rows.length + 1; // +1 for the hero action row
  useEffect(() => {
    setFocus((f) => {
      const r = Math.min(f.r, rowCount - 1);
      const rowLen = r === 0 ? 3 : (rows[r - 1]?.cards.length ?? 1);
      return { r, c: Math.min(f.c, Math.max(0, rowLen - 1)) };
    });
  }, [rowCount, rows]);

  useEffect(() => {
    const el = btnRefs.current.get(`${focus.r}-${focus.c}`);
    el?.focus();
  }, [focus]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onExit();
        return;
      }
      if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
      e.preventDefault();
      setFocus((f) => {
        const rowLen = (r: number) =>
          r === 0 ? 3 : (rows[r - 1]?.cards.length ?? 1);
        if (e.key === "ArrowUp") {
          const r = Math.max(0, f.r - 1);
          return { r, c: Math.min(f.c, rowLen(r) - 1) };
        }
        if (e.key === "ArrowDown") {
          const r = Math.min(rowCount - 1, f.r + 1);
          return { r, c: Math.min(f.c, rowLen(r) - 1) };
        }
        if (e.key === "ArrowLeft") return { r: f.r, c: (f.c + rowLen(f.r) - 1) % rowLen(f.r) };
        return { r: f.r, c: (f.c + 1) % rowLen(f.r) };
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, rowCount, onExit]);

  const reg = (r: number, c: number) => (el: HTMLButtonElement | null) => {
    const k = `${r}-${c}`;
    if (el) btnRefs.current.set(k, el);
    else btnRefs.current.delete(k);
  };

  return (
    <div className="tv" data-testid="tv-view">
      <p className="hero-kicker">TV Mode</p>
      {featured ? (
        <div className="tv-hero">
          <h2 className="tv-title">{featured.title}</h2>
          {featured.overview && <p className="tv-overview">{featured.overview}</p>}
          <div className="tv-actions">
            <button
              type="button"
              ref={reg(0, 0)}
              tabIndex={focus.r === 0 && focus.c === 0 ? 0 : -1}
              onFocus={() => setFocus({ r: 0, c: 0 })}
              onClick={fullScreen}
            >
              Full screen
            </button>
            <button
              type="button"
              ref={reg(0, 1)}
              tabIndex={focus.r === 0 && focus.c === 1 ? 0 : -1}
              onFocus={() => setFocus({ r: 0, c: 1 })}
              onClick={onShuffle}
            >
              Surprise me
            </button>
            <button
              type="button"
              className="btn-primary"
              ref={reg(0, 2)}
              tabIndex={focus.r === 0 && focus.c === 2 ? 0 : -1}
              onFocus={() => setFocus({ r: 0, c: 2 })}
              onClick={() => onWatchItem(featured)}
            >
              ▶ Watch Now
            </button>
          </div>
          {fsError && (
            <p role="alert" className="error">
              {fsError}
            </p>
          )}
        </div>
      ) : (
        <div className="tv-hero">
          <h2 className="tv-title">TV Mode</h2>
          <p className="muted">Nothing in the catalog yet.</p>
        </div>
      )}
      {rows.map((row, ri) => (
        <section key={row.key} aria-label={row.title} className="tv-row">
          <h3>{row.title}</h3>
          <ul className="tv-cards">
            {row.cards.map((card, ci) => (
              <li key={card.key}>
                <button
                  type="button"
                  ref={reg(ri + 1, ci)}
                  tabIndex={focus.r === ri + 1 && focus.c === ci ? 0 : -1}
                  onFocus={() => setFocus({ r: ri + 1, c: ci })}
                  onClick={() => row.onPick(ci)}
                  className="tv-card"
                >
                  <Artwork
                    title={card.label}
                    src={card.poster ?? null}
                    hue={card.hue ?? 270}
                    className="tv-thumb"
                    imgClassName="tv-img"
                  />
                  <span className="tv-label">{card.label}</span>
                  {card.sub && <span className="muted">{card.sub}</span>}
                  {card.progress !== undefined && card.progress > 0 && (
                    <span className="progress" aria-hidden="true">
                      <span className="progress-fill" style={{ width: `${Math.round(card.progress * 100)}%` }} />
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <p className="muted">Arrows move · Enter selects · Esc exits TV Mode</p>
    </div>
  );
}

const PARTY_ROOMS_KEY = "libre:party-rooms";

interface SavedRoom {
  code: string;
  name: string;
  title: string;
}

function readSavedRooms(): SavedRoom[] {
  try {
    const raw = localStorage.getItem(PARTY_ROOMS_KEY);
    const list = raw ? (JSON.parse(raw) as SavedRoom[]) : [];
    return Array.isArray(list) ? list.slice(0, 10) : [];
  } catch {
    return [];
  }
}

function saveRoom(room: SavedRoom): SavedRoom[] {
  const list = [room, ...readSavedRooms().filter((r) => r.code !== room.code)].slice(0, 10);
  try {
    localStorage.setItem(PARTY_ROOMS_KEY, JSON.stringify(list));
  } catch {
    // Private mode — rooms simply won't persist.
  }
  return list;
}

interface RoomMember {
  userId: string;
  name: string;
}

/** Resolve the first playable asset for an episode (null when locked). */
async function resolvePlayableAsset(
  episodeId: string,
): Promise<{ assetId: string; assets: string[] } | null> {
  const detail = await getMediaDetail(episodeId);
  const assets = detail.playable_assets_by_episode[episodeId] ?? [];
  if (assets.length === 0 || !assets[0]) return null;
  return { assetId: assets[0], assets };
}

/** /parties lobby: start a room from search, join by code, your rooms. */
function PartiesView({ user, onSignIn, onEnter }: {
  user: SessionUser | null;
  onSignIn: () => void;
  onEnter: (code: string) => void;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchResultItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [creatingId, setCreatingId] = useState<string | null>(null);
  const [rooms, setRooms] = useState<SavedRoom[]>(() => readSavedRooms());

  if (!user) {
    return (
      <section aria-label="Watch Parties" className="account-prompt" data-testid="parties-signin-prompt">
        <h2>Watch Parties</h2>
        <p className="muted">Sign in to start a room or join one with a code.</p>
        <button type="button" className="btn-primary" onClick={onSignIn}>
          Sign in
        </button>
      </section>
    );
  }

  const runSearch = async () => {
    const term = q.trim();
    if (!term) return;
    setSearching(true);
    setSearchError(null);
    try {
      const payload = await searchMedias(term);
      // Party rooms start from titles, not people.
      setHits(payload.results.filter((r) => r.type !== "person").slice(0, 8));
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : "search failed");
      setHits([]);
    } finally {
      setSearching(false);
    }
  };

  const resolveEpisode = async (item: SearchResultItem): Promise<string | null> => {
    if (item.type === "episode") return item.media_id;
    const detail = await getMediaDetail(item.media_id);
    const epId = Object.keys(detail.playable_assets_by_episode)[0];
    return epId ?? null;
  };

  const startRoom = async (item: SearchResultItem, roomName: string) => {
    setCreatingId(item.media_id);
    try {
      const episodeId = await resolveEpisode(item);
      if (!episodeId) {
        setSearchError("no playable episode behind this result");
        return;
      }
      const created = await createParty(episodeId, roomName || undefined);
      setRooms(saveRoom({ code: created.code, name: roomName || item.title, title: item.title }));
      onEnter(created.code);
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : "could not create room");
    } finally {
      setCreatingId(null);
    }
  };

  const joinRoom = async () => {
    const clean = code.trim().toUpperCase();
    if (!/^[A-Z2-9]{8}$/.test(clean)) {
      setJoinError("codes are 8 characters");
      return;
    }
    setJoinError(null);
    setJoining(true);
    try {
      const info = await getPartyInfo(clean);
      setRooms(saveRoom({ code: info.code, name: info.room_name ?? info.episode_title ?? clean, title: info.episode_title ?? clean }));
      onEnter(info.code);
    } catch {
      setJoinError("room not found or expired");
    } finally {
      setJoining(false);
    }
  };

  return (
    <div className="parties" data-testid="parties-view">
      <p className="hero-kicker">Together, from anywhere</p>
      <h2 className="tabview-title">Watch Parties</h2>
      <p className="muted">Choose a title, send the room code, and keep playback in step. Rooms stay active for 24 hours.</p>
      <div className="party-grid">
        <section aria-label="Start a room" className="party-card">
          <h3>Start a room</h3>
          <p className="muted">Search for what everyone will watch.</p>
          <form
            className="party-search"
            onSubmit={(event) => {
              event.preventDefault();
              void runSearch();
            }}
          >
            <input
              type="search"
              value={q}
              onChange={(event) => setQ(event.target.value)}
              placeholder="Search movies and series"
              aria-label="Search movies and series"
              data-testid="party-search-input"
            />
            <button type="submit" disabled={searching} data-testid="party-search-button">
              {searching ? "…" : "Search"}
            </button>
          </form>
          {searchError && (
            <p role="alert" className="error">
              {searchError}
            </p>
          )}
          <ul className="episode-list">
            {hits.map((item) => (
              <li key={`${item.type}:${item.media_id}`} className="episode-row">
                <div>
                  <strong>{item.title}</strong>
                  <p className="muted">{item.type}</p>
                </div>
                <button
                  type="button"
                  disabled={creatingId === item.media_id}
                  onClick={() => void startRoom(item, "")}
                  data-testid={`party-start-${item.media_id}`}
                >
                  {creatingId === item.media_id ? "…" : "Create"}
                </button>
              </li>
            ))}
          </ul>
        </section>
        <section aria-label="Join with a code" className="party-card">
          <h3>Join with a code</h3>
          <p className="muted">Room codes are eight characters.</p>
          <input
            className="code-input"
            value={code}
            onChange={(event) => setCode(event.target.value.toUpperCase().replace(/[^A-Z2-9]/g, "").slice(0, 8))}
            placeholder="AB12CD34"
            aria-label="Room code"
            data-testid="party-code-input"
          />
          <button
            type="button"
            className="btn-primary"
            disabled={joining}
            onClick={() => void joinRoom()}
            data-testid="party-join-button"
          >
            {joining ? "Joining…" : "Join room"}
          </button>
          {joinError && (
            <p role="alert" className="error">
              {joinError}
            </p>
          )}
        </section>
      </div>
      <section aria-label="Your rooms">
        <h3>Ready to watch</h3>
        {rooms.length === 0 ? (
          <div className="empty-panel">
            <p>Create a room or join one with a code.</p>
          </div>
        ) : (
          <ul className="episode-list">
            {rooms.map((room) => (
              <li key={room.code} className="episode-row">
                <div>
                  <strong>{room.name}</strong>
                  <p className="muted">{room.code}</p>
                </div>
                <button type="button" onClick={() => onEnter(room.code)}>
                  Open
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

interface PartyRoomViewProps {
  code: string;
  onExit: () => void;
}

/** In-room view: synced player (host drives, guests follow) + roster. */
function PartyRoomView({ code, onExit }: PartyRoomViewProps) {
  const [info, setInfo] = useState<{
    episodeId: string;
    title: string;
    hostName: string;
    roomName: string | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [assetId, setAssetId] = useState<string | null>(null);
  const [members, setMembers] = useState<RoomMember[]>([]);  const [isHost, setIsHost] = useState(false);
  const [syncNote, setSyncNote] = useState("connecting…");
  const wsRef = useRef<WebSocket | null>(null);
  const playerRef = useRef<{ play: () => void; pause: () => void; seekTo: (s: number) => void } | null>(null);
  const lastSent = useRef({ position: -10, at: 0 });
  // Stable source object: VideoPlayer reloads whenever its identity changes,
  // so this must only change when the asset does (not every render).
  const roomSource = useMemo(
    () => (assetId ? { type: "hls" as const, url: playbackUrl(assetId) } : null),
    [assetId],
  );

  useEffect(() => {
    let cancelled = false;
    let ws: WebSocket | null = null;
    let pingTimer: number | undefined;

    (async () => {
      try {
        const detail = await getPartyInfo(code);
        if (cancelled) return;
        const resolved = await resolvePlayableAsset(detail.episode_id);
        if (cancelled) return;
        if (!resolved) {
          setError("no playable media for your session in this room");
          return;
        }
        setInfo({
          episodeId: detail.episode_id,
          title: detail.episode_title ?? detail.series_name ?? code,
          hostName: detail.host_name,
          roomName: detail.room_name,
        });
        setAssetId(resolved.assetId);

        // Single-use ticket first (works cross-site); the socket also
        // accepts the session cookie where it travels.
        let url = partySocketUrl(code);
        try {
          const ticket = await getPartyTicket(code);
          if (cancelled) return;
          url += `?ticket=${encodeURIComponent(ticket)}`;
        } catch {
          // Fall through to cookie auth.
        }
        if (cancelled) return;
        ws = new WebSocket(url);
        wsRef.current = ws;
        ws.onopen = () => {
          ws?.send(JSON.stringify({ t: "hello" }));
        };
        ws.onmessage = (event) => {
          let msg: { t?: string; position?: number; playing?: boolean; members?: RoomMember[]; you?: string; is_host?: boolean; message?: string };
          try {
            msg = JSON.parse(String(event.data));
          } catch {
            return;
          }
          if (msg.t === "joined") {
            setMembers(msg.members ?? []);
            setIsHost(msg.is_host === true);
            setSyncNote(msg.is_host === true ? "you are driving playback" : "synced with host");
            if (typeof msg.position === "number" && msg.position > 5) {
              playerRef.current?.seekTo(msg.position);
            }
          } else if (msg.t === "members") {
            setMembers(msg.members ?? []);
          } else if (msg.t === "sync") {
            setSyncNote("synced with host");
            const video = document.querySelector<HTMLVideoElement>("#party-player video");
            const pos = typeof msg.position === "number" ? msg.position : 0;
            if (video && Math.abs(video.currentTime - pos) > 3) {
              playerRef.current?.seekTo(pos);
            }
            if (msg.playing && video?.paused) playerRef.current?.play();
            if (!msg.playing && video && !video.paused) playerRef.current?.pause();
          } else if (msg.t === "error") {
            setSyncNote(msg.message ?? "room error");
          }
        };
        ws.onclose = () => {
          if (!cancelled) setSyncNote("disconnected — rejoin to resume sync");
        };

        // Heartbeat keeps membership fresh (server prunes after 30s).
        pingTimer = window.setInterval(() => {
          const sock = wsRef.current;
          if (sock && sock.readyState === WebSocket.OPEN) {
            try {
              sock.send(JSON.stringify({ t: "ping" }));
            } catch { /* closed meanwhile */ }
          }
        }, 20000);
      } catch {
        if (!cancelled) setError("room not found or expired");
      }
    })();

    return () => {
      cancelled = true;
      window.clearInterval(pingTimer);
      try {
        wsRef.current?.send(JSON.stringify({ t: "bye" }));
      } catch { /* already closed */ }
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [code]);

  // Host broadcast driven off the shared player store.
  useEffect(() => {
    if (!isHost) return undefined;
    const timer = window.setInterval(() => {
      const sock = wsRef.current;
      if (!sock || sock.readyState !== WebSocket.OPEN) return;
      const st = usePlayerStore.getState();
      if (!Number.isFinite(st.currentTime)) return;
      const moved = Math.abs(st.currentTime - lastSent.current.position) > 2;
      const stale = Date.now() - lastSent.current.at > 5000;
      if ((st.isPlaying && (moved || stale)) || (!st.isPlaying && moved)) {
        lastSent.current = { position: st.currentTime, at: Date.now() };
        try {
          sock.send(JSON.stringify({ t: "state", position: st.currentTime, playing: st.isPlaying }));
        } catch { /* closed meanwhile */ }
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isHost]);

  const leave = () => {
    try {
      wsRef.current?.send(JSON.stringify({ t: "bye" }));
    } catch { /* already closed */ }
    wsRef.current?.close();
    onExit();
  };

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setSyncNote(`code ${code} copied — send it to everyone`);
    } catch {
      setSyncNote(`code: ${code}`);
    }
  };

  return (
    <div className="party-room" data-testid="party-room">
      <button type="button" onClick={leave}>
        ← Leave room
      </button>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {info && (
        <>
          <p className="hero-kicker">{info.roomName ?? "Watch party"}</p>
          <h2>{info.title}</h2>
          <p className="muted" data-testid="party-code">
            Room {code} · host {info.hostName} · {members.length} watching
          </p>
          <div className="party-room-actions">
            <button type="button" onClick={() => void copyCode()}>
              Copy code
            </button>
          </div>
          {assetId && roomSource ? (
            <section id="party-player" aria-label="Party player" className="player-wrap" data-testid="party-player">
              <VideoPlayer
                ref={playerRef}
                source={roomSource}
                title={info.title}
                onBack={leave}
              />
            </section>
          ) : (
            !error && <p className="muted">resolving your playable source…</p>
          )}
          <p className="muted" data-testid="party-sync-note">{syncNote}</p>
          {members.length > 0 && (
            <ul className="member-list" data-testid="party-members">
              {members.map((m) => (
                <li key={m.userId}>{m.name}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

interface SettingsViewProps {
  rotateHero: boolean;
  onToggleRotate: (value: boolean) => void;
  theme: ThemePreference;
  onSelectTheme: (value: ThemePreference) => void;
  serverOrder: ServerProvider[];
  onReorderServers: (order: ServerProvider[]) => void;
  watchCount: number;
  onClearWatching: () => void;
}

/** /settings — hero rotation, appearance and local watch history. */
function SettingsView({ rotateHero, onToggleRotate, theme, onSelectTheme, serverOrder, onReorderServers, watchCount, onClearWatching }: SettingsViewProps) {
  const [cleared, setCleared] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const moveServer = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0) return;
    const next = [...serverOrder];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    onReorderServers(next);
  };
  return (
    <div className="settings" data-testid="settings-view">
      <p className="hero-kicker">Your Libre</p>
      <h2>Settings</h2>
      <p className="muted">Everything here takes effect immediately on this device.</p>
      <section aria-label="Home" className="settings-card">
        <h3>Home</h3>
        <div className="settings-row">
          <div>
            <strong>Rotate featured titles</strong>
            <p className="muted">Cycle the home billboard every few seconds.</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={rotateHero}
            className={`switch${rotateHero ? " switch-on" : ""}`}
            onClick={() => onToggleRotate(!rotateHero)}
            data-testid="setting-rotate"
          >
            <span className="switch-knob" aria-hidden="true" />
            <span className="switch-label">{rotateHero ? "On" : "Off"}</span>
          </button>
        </div>
      </section>
      <section aria-label="Server order" className="settings-card server-order-card">
        <h2>Server Order</h2>
        <p className="muted">Drag to set which sources are tried first when a title loads.</p>
        <ul className="server-order-list" data-testid="server-order-list">
          {serverOrder.map((name, index) => (
            <li
              key={name}
              className={`server-order-item${dragIndex === index ? " dragging" : ""}`}
              draggable
              onDragStart={() => setDragIndex(index)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (dragIndex !== null) moveServer(dragIndex, index);
                setDragIndex(null);
              }}
              onDragEnd={() => setDragIndex(null)}
            >
              <span className="server-grip" aria-hidden="true">⠿</span>
              <span className="server-name">{name}</span>
              <span className="server-rank">{index + 1}</span>
            </li>
          ))}
        </ul>
        <div className="server-order-actions">
          <button
            type="button"
            onClick={() => moveServer(serverOrder.length - 1, 0)}
            data-testid="server-move-top"
          >
            Move last to first
          </button>
          <button type="button" onClick={() => onReorderServers([...SERVER_PROVIDERS])}>
            Reset order
          </button>
        </div>
      </section>
      <section aria-label="Appearance" className="settings-card">
        <h3>Appearance</h3>
        <div className="settings-row">
          <div>
            <strong>Theme</strong>
            <p className="muted">System follows your device setting; Light and Dark stay fixed.</p>
          </div>
          <div className="theme-picker" role="group" aria-label="Theme">
            {(["system", "light", "dark"] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={`theme-option${theme === value ? " theme-option-active" : ""}`}
                aria-pressed={theme === value}
                onClick={() => onSelectTheme(value)}
                data-testid={`setting-theme-${value}`}
              >
                {value[0].toUpperCase() + value.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </section>
      <section aria-label="Playback" className="settings-card">
        <h3>Playback</h3>
        <div className="settings-row">
          <div>
            <strong>Continue Watching history</strong>
            <p className="muted">
              {watchCount > 0
                ? `${watchCount} entr${watchCount === 1 ? "y" : "ies"} stored on this device.`
                : "Nothing stored on this device."}
            </p>
          </div>
          <button
            type="button"
            disabled={watchCount === 0}
            onClick={() => {
              onClearWatching();
              setCleared(true);
            }}
            data-testid="setting-clear-watching"
          >
            Clear
          </button>
        </div>
      </section>
      {cleared && watchCount === 0 && <p className="muted">Watch history cleared.</p>}
    </div>
  );
}

interface AccountViewProps {
  user: SessionUser | null;
  authChecked: boolean;
  catalog: MediaListItem[];
  continueWatching: ContinueEntry[];
  sessionExpires: number | null;
  onSignIn: () => void;
  onLogout: () => void;
  onPlay: (assetId: string, title: string, startAt?: number, episodeId?: string) => void;
  onBrowse: () => void;
}

/** /account — profile page. Every number shown is computed from real local
    data (catalog + Continue Watching history + session). No dead sections. */
function AccountView({
  user,
  authChecked,
  catalog,
  continueWatching,
  sessionExpires,
  onSignIn,
  onLogout,
  onPlay,
  onBrowse,
}: AccountViewProps) {
  if (!authChecked) return <p className="muted">checking session…</p>;

  if (!user) {
    return (
      <section aria-label="Account" className="account-prompt" data-testid="account-signin-prompt">
        <span className="avatar avatar-xl avatar-guest" aria-hidden="true">?</span>
        <h2>Your Libre</h2>
        <p className="muted">Sign in to see your watch snapshot and pick up where you left off.</p>
        <button type="button" className="btn-primary" onClick={onSignIn}>
          Sign in
        </button>
      </section>
    );
  }

  const displayName = user.display_name ?? user.email;
  const playableCount = catalog.filter((c) => c.playable).length;
  const minutesWatched = Math.round(
    continueWatching.reduce((sum, e) => sum + e.position, 0) / 60,
  );
  const latest = continueWatching[0];
  const expiry = sessionExpires
    ? new Date(sessionExpires * 1000).toLocaleString()
    : null;

  const stats = [
    { label: "titles in catalog", value: String(catalog.length) },
    { label: "playable now", value: String(playableCount) },
    { label: "continue watching", value: String(continueWatching.length) },
    { label: "minutes watched", value: String(minutesWatched) },
  ];

  return (
    <div className="account">
      <section aria-label="Profile" className="profile-hero" data-testid="profile-hero">
        <p className="hero-kicker">Your Libre</p>
        <div className="profile-row">
          <span
            className="avatar avatar-xl"
            aria-hidden="true"
            style={{ "--avatar-hue": hueFor(user.id) } as React.CSSProperties}
          >
            {displayName.charAt(0).toUpperCase()}
          </span>
          <div className="profile-id">
            <h2 data-testid="profile-name">{displayName}</h2>
            <p className="muted">Your watch life, synced and organized in one place.</p>
            <p className="muted" data-testid="profile-email">Account: {user.email}</p>
          </div>
          <div className="profile-actions">
            {latest ? (
              <button
                type="button"
                className="btn-primary"
                onClick={() => onPlay(latest.assetId, latest.title, latest.position, latest.episodeId)}
                data-testid="profile-continue"
              >
                ▶ Continue watching
              </button>
            ) : (
              <button
                type="button"
                className="btn-primary"
                onClick={onBrowse}
                data-testid="profile-continue"
              >
                ▶ Browse titles
              </button>
            )}
            <button type="button" onClick={onLogout} data-testid="logout-button">
              Log out
            </button>
          </div>
        </div>
      </section>

      <section aria-label="At a glance" className="snapshot">
        <p className="hero-kicker">At a glance</p>
        <h2>Your watch snapshot</h2>
        <ul className="stat-grid" data-testid="profile-stats">
          {stats.map((s) => (
            <li key={s.label} className="stat-card">
              <span className="stat-value">{s.value}</span>
              <span className="stat-label">{s.label}</span>
            </li>
          ))}
        </ul>
      </section>

      {continueWatching.length > 0 && (
        <section aria-label="Continue Watching" className="rail-section">
          <h2>Continue Watching</h2>
          <ul className="rail" data-testid="account-continue-list">
            {continueWatching.map((entry) => {
              const pct =
                entry.duration > 0
                  ? Math.min(100, Math.round((entry.position / entry.duration) * 100))
                  : 0;
              return (
                <li key={entry.assetId} className="rail-card cw-card">
                  <button
                    type="button"
                    onClick={() => onPlay(entry.assetId, entry.title, entry.position)}
                  >
                    <span
                      className="rail-poster"
                      style={{ "--tile-hue": hueFor(entry.assetId) } as React.CSSProperties}
                      aria-hidden="true"
                    >
                      {entry.title.charAt(0).toUpperCase()}
                    </span>
                    <span className="rail-title">{entry.title}</span>
                    <span className="progress" aria-hidden="true">
                      <span className="progress-fill" style={{ width: `${pct}%` }} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section aria-label="This session" className="session-card" data-testid="session-card">
        <div>
          <h2>This session</h2>
          <p className="muted">
            Signed in as {user.email}
            {expiry ? ` — session expires ${expiry}` : ""}
          </p>
        </div>
        <button type="button" onClick={onLogout}>
          Log out
        </button>
      </section>
    </div>
  );
}

type Route = "/" | "/search" | "/account" | "/library" | "/calendar" | "/settings" | "/tv" | "/anime" | "/movies" | "/shows" | "/live" | "/parties" | "/title" | "/person" | "/watch" | "/404";

function routeOf(pathname: string): Route {
  if (pathname === "/search") return "/search";
  if (pathname === "/account") return "/account";
  if (pathname === "/library") return "/library";
  if (pathname === "/calendar") return "/calendar";
  if (pathname === "/settings") return "/settings";
  if (pathname === "/tv") return "/tv";
  if (pathname === "/anime") return "/anime";
  if (pathname === "/movies") return "/movies";
  if (pathname === "/shows") return "/shows";
  if (pathname === "/live") return "/live";
  if (pathname === "/parties") return "/parties";
  if (pathname.startsWith("/title/")) return "/title";
  if (pathname.startsWith("/person/")) return "/person";
  if (pathname.startsWith("/watch/")) return "/watch";
  if (pathname !== "/") return "/404";
  return "/";
}

/** "/title/abc" → "abc" ("" when the path carries no id). */
function idAfter(pathname: string, prefix: "/title/" | "/person/"): string {
  return decodeURIComponent(pathname.slice(prefix.length).split("/")[0] ?? "");
}

function readRotateHero(): boolean {
  try {
    const raw = localStorage.getItem("libre:prefs");
    if (!raw) return true;
    return (JSON.parse(raw) as { rotate?: unknown }).rotate !== false;
  } catch {
    return true;
  }
}

const SERVER_PROVIDERS = ["Light", "Nebula", "Sirius", "Rigel", "Polaris", "Warsaw", "Munich", "Paris"] as const;
type ServerProvider = (typeof SERVER_PROVIDERS)[number];

type ThemePreference = "system" | "light" | "dark";

function readTheme(): ThemePreference {
  try {
    const value = localStorage.getItem("libre:theme");
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

function readServerOrder(): ServerProvider[] {
  try {
    const raw = localStorage.getItem("libre:server-order");
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [...SERVER_PROVIDERS];
    const valid = parsed.filter((name): name is ServerProvider => SERVER_PROVIDERS.includes(name as ServerProvider));
    const missing = SERVER_PROVIDERS.filter((name) => !valid.includes(name));
    return [...new Set([...valid, ...missing])];
  } catch {
    return [...SERVER_PROVIDERS];
  }
}

function readFollowedPeople(): string[] {
  try {
    const raw = localStorage.getItem("libre:followed-people");
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** Reflect the preference (and, for "system", the OS setting) onto <html>. */
function applyTheme(pref: ThemePreference): void {
  const mode = pref === "system"
    ? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
    : pref;
  document.documentElement.dataset.theme = pref;
  document.documentElement.dataset.mode = mode;
}

/** One catalog card (poster artwork + title + playable badge). */
function SeriesCard({ item, loggedIn, onOpen, testid }: {
  item: MediaListItem;
  loggedIn: boolean;
  onOpen: (seriesId: string) => void;
  testid?: string;
}) {
  return (
    <li key={item.id} className="rail-card" data-testid={testid}>
      <button type="button" onClick={() => void onOpen(item.id)}>
        <Artwork
          title={item.title}
          src={item.poster_key}
          hue={hueFor(item.id)}
          className="rail-poster"
          imgClassName="rail-img"
        />
        <span className="rail-title">{item.title}</span>
        <span className={`badge ${item.playable ? "badge-ok" : "badge-locked"}`}>
          {item.playable ? "Playable" : loggedIn ? "No access" : "Login to play"}
        </span>
      </button>
    </li>
  );
}

/** A titled rail with its own scroll arrows. Renders nothing when empty. */
function CategoryRail({ id, title, items, loggedIn, onOpen, testid }: {
  id: string;
  title: string;
  items: MediaListItem[];
  loggedIn: boolean;
  onOpen: (seriesId: string) => void;
  testid?: string;
}) {
  const ref = useRef<HTMLUListElement | null>(null);
  if (items.length === 0) return null;
  const slide = (dir: 1 | -1) => {
    const el = ref.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: "smooth" });
  };
  return (
    <section id={id} aria-label={title} className="rail-section">
      <div className="rail-head">
        <h2>{title}</h2>
      </div>
      <div className="rail-wrap">
        <button
          type="button"
          className="rail-edge left"
          aria-label={`Scroll ${title} left`}
          onClick={() => slide(-1)}
        >
          ‹
        </button>
        <ul className="rail" data-testid={testid} ref={ref}>
          {items.map((item) => (
            <SeriesCard key={item.id} item={item} loggedIn={loggedIn} onOpen={onOpen} />
          ))}
        </ul>
        <button
          type="button"
          className="rail-edge right"
          aria-label={`Scroll ${title} right`}
          onClick={() => slide(1)}
        >
          ›
        </button>
      </div>
    </section>
  );
}

function topGenres(items: MediaListItem[], limit = 4): Array<{ genre: string; items: MediaListItem[] }> {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const g of item.genres) counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([genre]) => ({ genre, items: items.filter((i) => i.genres.includes(genre)).slice(0, 12) }))
    .filter((g) => g.items.length > 0);
}

/** TMDB profile/photo path → sized image URL (paths stored raw, e.g. "/abc.jpg"). */
function tmdbImg(path: string | null, size: "w185" | "h632"): string | null {
  if (!path || !path.startsWith("/")) return null;
  return `https://image.tmdb.org/t/p/${size}${path}`;
}

/** 135 → "2h 15m", 45 → "45m". */
function formatRuntime(minutes: number | null): string | null {
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** "2026-09-18T…" → "Sep 2026". */
function formatMonthYear(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

/** "2008-09-23" → "Sep 23, 2008". */
function formatFullDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** "1970-07-30" → full years old, null when unknown. */
function ageFor(birthday: string | null): number | null {
  if (!birthday) return null;
  const b = new Date(`${birthday}T00:00:00Z`);
  if (Number.isNaN(b.getTime())) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - b.getUTCFullYear();
  const m = now.getUTCMonth() - b.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < b.getUTCDate())) age--;
  return age >= 0 ? age : null;
}

/** "1970-07-30" → "July 30, 1970". */
function formatBirthDate(birthday: string | null): string | null {
  if (!birthday) return null;
  const d = new Date(`${birthday}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

interface TitleDetailProps {
  detail: MediaDetail;
  loggedIn: boolean;
  bookmarkIds: ReadonlySet<string>;
  /** Measured nav height: lifts the hero backdrop behind the floating nav. */
  navLift: number;
  onToggleBookmark: (episodeId: string) => void;
  onPlayEpisode: (episodeId: string, title: string, assets: string[]) => void;
  onWatchNow: () => void;
  onOpenPerson: (personId: string) => void;
  onOpenTitle: (seriesId: string) => void;
  onBack: () => void;
}

/** Cinematic title page: backdrop hero, meta, actions, cast, reviews, similar, episodes. */
function TitleDetailView({
  detail, loggedIn, bookmarkIds, navLift, onToggleBookmark, onPlayEpisode,
  onWatchNow, onOpenPerson, onOpenTitle, onBack,
}: TitleDetailProps) {
  const [trailerOpen, setTrailerOpen] = useState(false);
  const [shareNote, setShareNote] = useState<string | null>(null);
  const [openReview, setOpenReview] = useState<number | null>(null);

  const episodes = useMemo(
    () => detail.seasons.flatMap((s) => s.episodes.map((e) => ({ season: s.season_num, ep: e }))),
    [detail],
  );
  const firstEp = episodes[0]?.ep ?? null;
  const firstPlayable = useMemo(
    () => episodes.find(({ ep }) => (detail.playable_assets_by_episode[ep.id] ?? []).length > 0) ?? null,
    [episodes, detail],
  );
  const seasonCount = detail.seasons.length;
  /** Default to the first regular season (specials are season 0). */
  const defaultSeasonNum =
    detail.seasons.find((s) => s.season_num >= 1)?.season_num
    ?? detail.seasons[0]?.season_num
    ?? 0;
  const [seasonNum, setSeasonNum] = useState(defaultSeasonNum);
  const [shieldOn, setShieldOn] = useState(true);
  const [revealedIds, setRevealedIds] = useState<string[]>([]);
  const seasonEps =
    detail.seasons.find((s) => s.season_num === seasonNum)?.episodes
    ?? detail.seasons[0]?.episodes
    ?? [];
  const showEpisodes = episodes.length > 1;
  const saved = firstEp ? bookmarkIds.has(firstEp.id) : false;

  const runtime = formatRuntime(detail.runtime_minutes);
  const seasonLabel = seasonCount > 0 ? `${seasonCount} Season${seasonCount === 1 ? "" : "s"}` : null;
  const metaBits = (showEpisodes
    ? [
        detail.year ? String(detail.year) : null,
        seasonLabel,
        detail.genres.length > 0 ? detail.genres.join(" · ") : null,
      ]
    : [
        detail.year ? String(detail.year) : null,
        runtime,
        detail.genres.length > 0 ? detail.genres.join(" · ") : null,
      ]
  ).filter((b): b is string => b !== null);

  const share = async () => {
    const url = `${window.location.origin}/title/${encodeURIComponent(detail.id)}`;
    try {
      await navigator.clipboard.writeText(url);
      setShareNote("Link copied — send it to anyone.");
    } catch {
      setShareNote(url);
    }
  };

  return (
    <div className="title-detail" data-testid="title-detail">
      <header
        className="hero title-hero"
        style={{ "--hero-hue": hueFor(detail.id), "--nav-lift": `${navLift}px` } as React.CSSProperties}
      >
        <span
          className="hero-watermark"
          aria-hidden="true"
        >
          {detail.name.charAt(0).toUpperCase()}
        </span>
        <HeroPhoto key={`title-${detail.id}`} src={detail.fanart_key} />
        <button type="button" className="title-back" onClick={onBack} aria-label="Back">
          ←
        </button>
        <div className="hero-body">
          <HeroTitle title={detail.name} logo={detail.logo_key} />
          <p className="title-meta">
            {detail.score !== null && (
              <span className="score-badge">★ {detail.score.toFixed(1)}</span>
            )}
            {metaBits.map((b) => (
              <span key={b} className="meta-bit">{b}</span>
            ))}
          </p>
          {detail.tagline && <p className="title-tagline">{detail.tagline}</p>}
          {detail.overview && <p className="hero-overview">{detail.overview}</p>}
          <div className="hero-actions title-actions">
            {firstPlayable && (
              <button type="button" className="btn-primary" onClick={onWatchNow} data-testid="title-watch-now">
                {showEpisodes
                  ? `▶ Play S${firstPlayable.season} E${firstPlayable.ep.episode_num}`
                  : "▶ Watch now"}
              </button>
            )}
            {loggedIn && firstEp && (
              <button
                type="button"
                className={saved ? "btn-saved" : ""}
                aria-pressed={saved}
                onClick={() => onToggleBookmark(firstEp.id)}
                data-testid="title-my-list"
              >
                {saved ? "★ Listed" : "+ My List"}
              </button>
            )}
            {detail.trailer && (
              <button type="button" onClick={() => setTrailerOpen(true)} data-testid="title-trailer">
                🎬 Trailer
              </button>
            )}
            <button type="button" onClick={() => void share()} data-testid="title-share">
              ⤴ Share
            </button>
            {detail.imdb_id && (
              <a
                className="imdb-link"
                href={`https://www.imdb.com/title/${encodeURIComponent(detail.imdb_id)}/`}
                target="_blank"
                rel="noreferrer"
                data-testid="title-imdb"
              >
                IMDb
              </a>
            )}
          </div>
          {shareNote && <p className="muted">{shareNote}</p>}
          {!firstPlayable && (
            <p className="muted">No playable media for this title in your session yet.</p>
          )}
        </div>
      </header>

      {showEpisodes && (
        <section aria-label="Episodes" className="title-section">
          <div className="section-head">
            <div>
              <h2>Episodes</h2>
              {shieldOn && (
                <p className="muted">
                  Showing {seasonEps.length} of {seasonEps.length} · select hidden episodes to reveal them
                </p>
              )}
            </div>
            <div className="filter-row">
              <button
                type="button"
                role="switch"
                aria-checked={shieldOn}
                className={`switch switch-mini${shieldOn ? " switch-on" : ""}`}
                onClick={() => setShieldOn((v) => !v)}
                data-testid="spoiler-shield"
              >
                <span className="switch-knob" aria-hidden="true" />
                <span className="switch-label">Spoiler shield</span>
              </button>
              {detail.seasons.length > 1 && (
                <select
                  aria-label="Season"
                  value={seasonNum}
                  onChange={(e) => {
                    setSeasonNum(Number(e.target.value));
                    setRevealedIds([]);
                  }}
                  className="sort-select"
                  data-testid="season-select"
                >
                  {detail.seasons.map((s) => (
                    <option key={s.id} value={s.season_num}>
                      Season {s.season_num}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>
          <ul className="episode-grid" data-testid="episode-grid">
            {seasonEps.map((episode, idx) => {
              const assets = detail.playable_assets_by_episode[episode.id] ?? [];
              const playable = assets.length > 0;
              const hidden = shieldOn && !revealedIds.includes(episode.id) && idx !== 0;
              const sub = [
                episode.runtime_minutes ? `${episode.runtime_minutes}m` : null,
                formatFullDate(episode.release_date),
              ].filter((x): x is string => x !== null).join(" · ");
              const thumb = hidden || !episode.still_key ? null : episode.still_key;
              if (hidden) {
                return (
                  <li key={episode.id}>
                    <button
                      type="button"
                      className="ep-card"
                      onClick={() => setRevealedIds((prev) => [...prev, episode.id])}
                    >
                      <span className="ep-thumb ep-thumb-hidden" aria-hidden="true">
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
                          <circle cx="12" cy="12" r="3" />
                        </svg>
                      </span>
                      <span className="ep-body">
                        <strong>{episode.episode_num}. Episode details hidden</strong>
                        {sub && <span className="muted">{sub}</span>}
                        <span className="muted">Select to reveal</span>
                      </span>
                    </button>
                  </li>
                );
              }
              const inner = (
                <>
                  {thumb ? (
                    <img src={thumb} alt="" aria-hidden="true" className="ep-thumb" loading="lazy" />
                  ) : (
                    <span className="ep-thumb ep-thumb-fallback" aria-hidden="true">
                      E{episode.episode_num}
                    </span>
                  )}
                  <span className="ep-body">
                    <strong>{episode.episode_num}. {episode.title}</strong>
                    {sub && <span className="muted">{sub}</span>}
                    {episode.overview && <span className="muted ep-overview">{episode.overview}</span>}
                    {!playable && <span className="muted">Locked</span>}
                  </span>
                </>
              );
              return (
                <li key={episode.id}>
                  {playable ? (
                    <button
                      type="button"
                      className="ep-card"
                      onClick={() => onPlayEpisode(episode.id, episode.title, assets)}
                      data-testid={`play-episode-${episode.id}`}
                    >
                      {inner}
                    </button>
                  ) : (
                    <div className="ep-card ep-locked">{inner}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {trailerOpen && detail.trailer && (
        <div
          className="modal-backdrop"
          data-testid="trailer-modal"
          onClick={() => setTrailerOpen(false)}
        >
          <div
            className="trailer-modal"
            role="dialog"
            aria-modal="true"
            aria-label={`${detail.name} trailer`}
            onClick={(event) => event.stopPropagation()}
          >
            <button type="button" className="modal-close" aria-label="Close trailer" onClick={() => setTrailerOpen(false)}>
              ✕
            </button>
            <iframe
              className="trailer-frame"
              src={`https://www.youtube.com/embed/${encodeURIComponent(detail.trailer.key)}?autoplay=1&rel=0`}
              title={`${detail.name} trailer`}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
            />
          </div>
        </div>
      )}

      {detail.cast.length > 0 && (
        <section aria-label="Cast" className="title-section">
          <h2>Cast</h2>
          <ul className="cast-rail" data-testid="title-cast">
            {detail.cast.map((c) => {
              const photo = tmdbImg(c.photo_path, "w185");
              return (
                <li key={c.person_id}>
                  <button type="button" className="cast-card" onClick={() => onOpenPerson(c.tmdb_id !== null ? String(c.tmdb_id) : c.person_id)}>
                    {photo ? (
                      <img src={photo} alt={c.name} className="cast-photo" loading="lazy" />
                    ) : (
                      <span className="cast-photo cast-fallback" aria-hidden="true">
                        {c.name.charAt(0).toUpperCase()}
                      </span>
                    )}
                    <span className="cast-name">{c.name}</span>
                    {c.character && <span className="muted cast-char">{c.character}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {detail.reviews.length > 0 && (
        <section aria-label="Audience reviews" className="title-section">
          <div className="section-head">
            <div>
              <h2>Audience reviews</h2>
              <p className="muted">Excerpts from TMDB members</p>
            </div>
            {detail.tmdb_id !== null && (detail.kind === "movie" || detail.kind === "tv") && (
              <a
                className="all-reviews"
                href={`https://www.themoviedb.org/${detail.kind}/${detail.tmdb_id}/reviews`}
                target="_blank"
                rel="noreferrer"
                data-testid="title-all-reviews"
              >
                ↗ All reviews
              </a>
            )}
          </div>
          <ul className="review-grid" data-testid="title-reviews">
            {detail.reviews.map((r, i) => {
              const open = openReview === i;
              const long = r.content.length > 280;
              const text = open || !long ? r.content : `${r.content.slice(0, 280)}…`;
              const reviewUrl = r.tmdb_review_id
                ? `https://www.themoviedb.org/review/${encodeURIComponent(r.tmdb_review_id)}`
                : null;
              return (
                <li key={`${r.author}-${i}`} className="review-card">
                  <div className="review-head">
                    <strong>{r.author}</strong>
                    {r.rating !== null && <span className="review-rating">★ {r.rating.toFixed(1)}/10</span>}
                  </div>
                  <p>{text}</p>
                  <div className="review-foot">
                    <span className="muted">{formatMonthYear(r.created_at)}</span>
                    {reviewUrl ? (
                      <a
                        className="review-link"
                        href={reviewUrl}
                        target="_blank"
                        rel="noreferrer"
                        data-testid={`review-link-${i}`}
                      >
                        Read full review
                      </a>
                    ) : (
                      long && (
                        <button type="button" onClick={() => setOpenReview(open ? null : i)}>
                          {open ? "Show less" : "Read full review"}
                        </button>
                      )
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {detail.similar.length > 0 && (
        <CategoryRail
          id="rail-similar"
          title="More Like This"
          items={detail.similar}
          loggedIn={loggedIn}
          onOpen={onOpenTitle}
          testid="title-similar"
        />
      )}

    </div>
  );
}

type CreditFilter = "all" | "movies" | "shows" | "anime";
type CreditSort = "best" | "newest" | "az";

interface PersonViewProps {
  person: PersonDetail;
  onBack: () => void;
  onOpenTitle: (seriesId: string) => void;
  onOpenPerson: (id: string) => void;
  following: boolean;
  onToggleFollow: () => void;
}

/** Person page: profile, bio, filterable/sortable filmography. */
function PersonView({ person, onBack, onOpenTitle, onOpenPerson, following, onToggleFollow }: PersonViewProps) {
  const [bioOpen, setBioOpen] = useState(false);
  const [shareNote, setShareNote] = useState<string | null>(null);
  const [filter, setFilter] = useState<CreditFilter>("all");
  const [sort, setSort] = useState<CreditSort>("newest");
  const [visible, setVisible] = useState(12);

  const age = ageFor(person.birthday);
  const birthday = formatBirthDate(person.birthday);
  const bioLong = (person.bio ?? "").length > 320;
  const bioText = !person.bio
    ? null
    : bioOpen || !bioLong
      ? person.bio
      : `${person.bio.slice(0, 320)}…`;

  const knownFor = useMemo(
    () => [...person.credits].sort((a, b) => (b.popularity ?? -1) - (a.popularity ?? -1)).slice(0, 6),
    [person.credits],
  );

  const counts = useMemo(
    () => ({
      all: person.credits.length,
      movies: person.credits.filter((c) => c.kind === "movie").length,
      shows: person.credits.filter((c) => c.kind === "tv" || c.kind === "series").length,
      anime: person.credits.filter((c) => c.kind === "anime").length,
    }),
    [person.credits],
  );

  const credits = useMemo(() => {
    const list = person.credits.filter((c) => {
      if (filter === "movies") return c.kind === "movie";
      if (filter === "shows") return c.kind === "tv" || c.kind === "series";
      if (filter === "anime") return c.kind === "anime";
      return true;
    });
    const by = {
      best: (a: (typeof list)[number], b: (typeof list)[number]) => (b.popularity ?? -1) - (a.popularity ?? -1),
      newest: (a: (typeof list)[number], b: (typeof list)[number]) => (b.year ?? -1) - (a.year ?? -1),
      az: (a: (typeof list)[number], b: (typeof list)[number]) => a.title.localeCompare(b.title),
    }[sort];
    return [...list].sort(by);
  }, [person.credits, filter, sort]);

  const shown = credits.slice(0, visible);
  const photo = tmdbImg(person.photo_path, "h632");

  const share = async () => {
    const url = `${window.location.origin}/person/${encodeURIComponent(String(person.tmdb_id ?? person.id))}`;
    try {
      await navigator.clipboard.writeText(url);
      setShareNote("Link copied — send it to anyone.");
    } catch {
      setShareNote(url);
    }
  };

  const collaboratorLabel = (c: PersonDetail["collaborators"][number]) => {
    if (c.shows > 0 && c.films === 0) return `${c.shows} ${c.shows === 1 ? "show" : "shows"}`;
    if (c.films > 0 && c.shows === 0) return `${c.films} ${c.films === 1 ? "film" : "films"}`;
    return `${c.shared} ${c.shared === 1 ? "title" : "titles"}`;
  };

  const kindLabel = (kind: string) =>
    kind === "movie" ? "Movie" : kind === "anime" ? "Anime" : "Series";

  return (
    <div className="person" data-testid="person-detail">
      <button type="button" className="person-back" onClick={onBack} aria-label="Back">
        ←
      </button>

      <div className="person-hero">
        {photo && <img src={photo} alt="" className="person-backdrop" aria-hidden="true" />}
        <div className="person-hero-inner">
          <div className="person-photo-wrap">
            {photo ? (
              <img src={photo} alt={person.name} className="person-photo" />
            ) : (
              <span className="person-photo person-fallback" aria-hidden="true">
                {person.name.charAt(0).toUpperCase()}
              </span>
            )}
          </div>
          <div className="person-info">
            <div className="person-title-row">
              <h2 className="person-name">{person.name}</h2>
              <button
                type="button"
                className={`follow-btn${following ? " following" : ""}`}
                aria-pressed={following}
                onClick={onToggleFollow}
                data-testid="person-follow"
              >
                <BellIcon size={15} />
                {following ? "Following" : "Follow"}
              </button>
            </div>
            {person.department && <p className="person-role">{person.department}</p>}
            <div className="person-facts">
              {birthday && (
                <span>
                  <span aria-hidden="true">▦</span> {birthday}
                  {age !== null ? ` (age ${age})` : ""}
                </span>
              )}
              {person.birthplace && (
                <span>
                  <span aria-hidden="true">◉</span> {person.birthplace}
                </span>
              )}
              {person.imdb_id && (
                <a
                  className="person-fact-link"
                  href={`https://www.imdb.com/name/${encodeURIComponent(person.imdb_id)}/`}
                  target="_blank"
                  rel="noreferrer"
                  data-testid="person-imdb"
                >
                  IMDb
                </a>
              )}
            </div>
            {bioText && <p className="person-bio">{bioText}</p>}
            {bioLong && (
              <button type="button" className="bio-toggle" onClick={() => setBioOpen((v) => !v)}>
                {bioOpen ? "Show less" : "Read full biography"}
              </button>
            )}
            <div className="hero-actions">
              <button type="button" onClick={() => void share()} data-testid="person-share">
                ⤴ Share
              </button>
            </div>
            {shareNote && <p className="muted">{shareNote}</p>}
          </div>
        </div>
      </div>

      {knownFor.length > 0 && (
        <section aria-label="Known for" className="title-section person-known">
          <h2>Known For</h2>
          <div className="known-rail">
            {knownFor.map((c) => (
              <button key={c.series_id} type="button" className="known-card" onClick={() => onOpenTitle(c.series_id)}>
                <Artwork
                  title={c.title}
                  src={c.poster_key}
                  hue={hueFor(c.series_id)}
                  className="known-art"
                  imgClassName="known-img"
                />
                <span className="known-title">{c.title}</span>
                <span className="known-meta">
                  {[c.character, c.score !== null ? `★ ${c.score.toFixed(1)}` : null, c.year]
                    .filter((x): x is string => x !== null && x !== "")
                    .join(" · ")}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {person.collaborators.length > 0 && (
        <section aria-label="Frequent collaborators" className="title-section person-collab">
          <h2>Frequent Collaborators</h2>
          <div className="collab-rail">
            {person.collaborators.map((c) => {
              const pPhoto = tmdbImg(c.photo_path, "h632");
              return (
                <button
                  key={c.id}
                  type="button"
                  className="collab-card"
                  onClick={() => onOpenPerson(c.tmdb_id ? String(c.tmdb_id) : c.id)}
                >
                  {pPhoto ? (
                    <img src={pPhoto} alt="" className="collab-photo" loading="lazy" />
                  ) : (
                    <span className="collab-photo collab-fallback" aria-hidden="true">
                      {c.name.charAt(0).toUpperCase()}
                    </span>
                  )}
                  <span className="collab-name">{c.name}</span>
                  <span className="collab-count">{collaboratorLabel(c)}</span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      <section aria-label="Filmography" className="title-section person-filmography">
        <div className="section-head">
          <h2>Filmography</h2>
          <select
            aria-label="Sort credits"
            value={sort}
            onChange={(e) => setSort(e.target.value as CreditSort)}
            className="sort-select"
          >
            <option value="newest">Newest</option>
            <option value="best">Best known</option>
            <option value="az">A–Z</option>
          </select>
        </div>
        <div className="pills film-tabs" role="group" aria-label="Filter credits">
          {(["all", "movies", "shows", "anime"] as CreditFilter[]).map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              className={filter === f ? "pill-active" : ""}
              onClick={() => {
                setFilter(f);
                setVisible(12);
              }}
            >
              {f === "all" ? "All" : f === "movies" ? "Movies" : f === "shows" ? "Shows" : "Anime"}
              <span className="pill-count">{counts[f]}</span>
            </button>
          ))}
        </div>
        {shown.length === 0 ? (
          <p className="muted">No titles in this filter yet.</p>
        ) : (
          <ul className="film-list" data-testid="person-credits">
            {shown.map((c) => (
              <li key={c.series_id}>
                <button type="button" onClick={() => onOpenTitle(c.series_id)}>
                  <Artwork
                    title={c.title}
                    src={c.poster_key}
                    hue={hueFor(c.series_id)}
                    className="film-thumb"
                    imgClassName="film-img"
                  />
                  <span className="film-body">
                    <span className="film-title">{c.title}</span>
                    {c.character && <span className="film-character">{c.character}</span>}
                    <span className="film-meta">
                      {[c.year ? String(c.year) : null, kindLabel(c.kind)]
                        .filter((x): x is string => x !== null)
                        .join(" · ")}
                    </span>
                  </span>
                  {c.score !== null && <span className="film-score">★ {c.score.toFixed(1)}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
        {visible < credits.length && (
          <button type="button" className="show-more" onClick={() => setVisible((v) => v + 12)}>
            Show all {credits.length}
          </button>
        )}
      </section>
    </div>
  );
}

interface MediaTabViewProps {
  kicker: string;
  title: string;
  subtitle: string;
  items: MediaListItem[];
  onOpen: (seriesId: string) => void;
  /** Active ?genre= filter (null when unfiltered). */
  genre: string | null;
  /** Active ?sort= value (popular | top). */
  sortMode: "popular" | "top" | null;
  onClearFilters: () => void;
  onPickGenre: (genre: string) => void;
  onPickSort: (mode: "popular" | "top") => void;
}

interface WatchViewProps {
  kind: string;
  extId: string;
  epId: string | null;
  onPlay: (
    assetId: string,
    title: string | undefined,
    startAt: number | undefined,
    episodeId: string | undefined,
    assets: string[],
  ) => void;
  activeSource: PlayerSource | null;
  srcList: string[];
  srcIndex: number;
  onSelectSource: (index: number) => void;
  sourceLabel: (id: string, index: number) => string;
  subtitles: Array<{ id: string; language: string; url: string }>;
  resumeAt: number | undefined;
  onFatalError: () => void;
  onExit: (seriesId: string | null) => void;
  onGoEpisodes: (seriesId: string) => void;
}

/** Dedicated watch theater (/watch/<kind>/<id>): resolves the clean URL to a
    catalog title, starts the requested (or first playable) episode, and plays
    it full-bleed. Reuses the shared playback state (subs, failover, history). */
function WatchView({
  kind, extId, epId, onPlay, activeSource, srcList, srcIndex,
  onSelectSource, sourceLabel, subtitles, resumeAt, onFatalError, onExit, onGoEpisodes,
}: WatchViewProps) {
  const [seriesId, setSeriesId] = useState<string | null>(null);
  const [wDetail, setWDetail] = useState<MediaDetail | null>(null);
  const [wError, setWError] = useState<string | null>(null);
  const [startedFor, setStartedFor] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const prevActive = useRef(activeSource);
  const tParam = new URLSearchParams(window.location.search).get("t") ?? "";
  const runKey = `${seriesId ?? ""}:${epId ?? ""}:${tParam}`;

  useEffect(() => {
    let cancelled = false;
    setSeriesId(null);
    setWDetail(null);
    setWError(null);
    setStartedFor(null);
    setReady(false);
    setExhausted(false);
    prevActive.current = null;
    (async () => {
      try {
        const resolved = await resolveWatch(kind, extId);
        if (cancelled) return;
        setSeriesId(resolved.series_id);
        const detail = await getMediaDetail(resolved.series_id);
        if (cancelled) return;
        setWDetail(detail);
      } catch (err) {
        if (!cancelled) setWError(err instanceof Error ? err.message : "could not load title");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [kind, extId]);

  useEffect(() => {
    if (!wDetail || !seriesId || startedFor === runKey) return;
    const playable = (id: string) => wDetail.playable_assets_by_episode[id] ?? [];
    const allIds = wDetail.seasons.flatMap((s) => s.episodes.map((e) => e.id));
    const target =
      epId && allIds.includes(epId) && playable(epId).length > 0
        ? epId
        : allIds.find((id) => playable(id).length > 0);
    if (!target) {
      setWError("No playable media for this title in your session yet.");
      return;
    }
    const assets = playable(target);
    const ep = wDetail.seasons.flatMap((s) => s.episodes).find((e) => e.id === target);
    const tRaw = new URLSearchParams(window.location.search).get("t");
    const tNum = tRaw !== null ? Number(tRaw) : NaN;
    const startAt = Number.isFinite(tNum) && tNum > 5 ? tNum : undefined;
    onPlay(assets[0]!, ep?.title ?? wDetail.name, startAt, target, assets);
    setStartedFor(runKey);
  }, [wDetail, seriesId, epId, startedFor, onPlay]);

  // Every source failed after playback began: the title is unplayable.
  useEffect(() => {
    if (startedFor && prevActive.current && !activeSource) setExhausted(true);
    prevActive.current = activeSource;
  }, [activeSource, startedFor]);

  const retry = () => {
    setWError(null);
    setExhausted(false);
    setReady(false);
    setStartedFor(null);
  };

  const prevEpisode = useMemo(() => {
    if (!wDetail || !epId) return null;
    const all = wDetail.seasons.flatMap((s) => s.episodes.map((e) => ({ season: s.season_num, ep: e })));
    const index = all.findIndex(({ ep }) => ep.id === epId);
    if (index <= 0) return null;
    const target = all[index - 1]!;
    const assets = wDetail.playable_assets_by_episode[target.ep.id] ?? [];
    if (assets.length === 0) return null;
    return () => onPlay(assets[0]!, target.ep.title, undefined, target.ep.id, assets);
  }, [wDetail, epId, onPlay]);

  if (wError && !wDetail) {
    return (
      <div className="watch watch-message" data-testid="watch-view">
        <p role="alert" className="error">{wError}</p>
        <button type="button" onClick={() => onExit(seriesId)}>
          ← Back
        </button>
      </div>
    );
  }
  const noSource = exhausted || (wError !== null && wDetail !== null);
  if (noSource && wDetail) {
    const totalEps = wDetail.seasons.reduce((n, s) => n + s.episodes.length, 0);
    return (
      <div className="watch" data-testid="watch-view">
        <div className="watch-cover" aria-hidden="true">
          {wDetail.fanart_key && /^https?:\/\//.test(wDetail.fanart_key) && (
            <img src={wDetail.fanart_key} alt="" className="watch-blur" />
          )}
        </div>
        <button type="button" className="title-back" onClick={() => onExit(seriesId)} aria-label="Back">
          ←
        </button>
        <div className="watch-nosource">
          <span className="watch-warn" aria-hidden="true">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3Z" />
              <path d="M12 9v4M12 17h.01" />
            </svg>
          </span>
          <h2>No playable source</h2>
          <p className="muted">None of the available servers could play this title right now.</p>
          <div className="watch-actions">
            <button type="button" className="watch-btn-primary" onClick={retry}>
              Try again
            </button>
            {totalEps > 1 && (
              <button type="button" onClick={() => seriesId && onGoEpisodes(seriesId)}>
                Episodes
              </button>
            )}
            <button type="button" onClick={() => onExit(seriesId)}>
              Go back
            </button>
          </div>
        </div>
      </div>
    );
  }
  // Loading: blurred art, title, episode line, staged progress.
  const showLoader = !ready && !noSource && !(wError && !wDetail);
  const phase = !wDetail ? 0 : 1;
  let epLine: string | null = null;
  if (wDetail) {
    const totalEps = wDetail.seasons.reduce((n, s) => n + s.episodes.length, 0);
    if (totalEps > 1) {
      const all = wDetail.seasons.flatMap((s) => s.episodes.map((e) => ({ season: s.season_num, ep: e })));
      const cur = (epId && all.find(({ ep }) => ep.id === epId)) || all[0];
      if (cur) epLine = `S${cur.season} · E${cur.ep.episode_num} — ${cur.ep.title}`;
    }
  }
  const status = !wDetail
    ? "Finding your title…"
    : srcList.length > 1
      ? "Fetching HD sources may take longer"
      : "Preparing your stream";

  return (
    <div className="watch" data-testid="watch-view">
      {showLoader && (
        <div className="watch-loader">
          <div className="watch-cover" aria-hidden="true">
            {wDetail?.fanart_key && /^https?:\/\//.test(wDetail.fanart_key) && (
              <img src={wDetail.fanart_key} alt="" className="watch-blur" />
            )}
          </div>
          <button type="button" className="title-back" onClick={() => onExit(seriesId)} aria-label="Back">
            ←
          </button>
          <div className="watch-load-body">
            <h2>{wDetail ? wDetail.name : "Loading…"}</h2>
            {epLine && <p className="muted">{epLine}</p>}
            <div className="watch-segments" aria-hidden="true">
              {[0, 1, 2].map((i) => (
                <span key={i} className={`watch-seg${i <= phase ? " watch-seg-fill" : ""}`} />
              ))}
            </div>
            <p className="muted">{status}</p>
            {activeSource && startedFor === runKey && (
              <button type="button" className="watch-btn-primary watch-play" onClick={() => setReady(true)}>
                ▶ Play
              </button>
            )}
          </div>
        </div>
      )}
      {activeSource && startedFor === runKey && (
        <VideoPlayer
          source={activeSource}
          startAt={resumeAt}
          subtitles={subtitles}
          onFatalError={onFatalError}
          onFirstFrame={() => setReady(true)}
          title={wDetail?.name}
          year={wDetail?.year ?? null}
          episodeLabel={epLine}
          onPrevEpisode={prevEpisode ?? undefined}
          sourceList={srcList}
          sourceIndex={srcIndex}
          onSelectSource={onSelectSource}
          sourceLabel={sourceLabel}
          onBack={() => onExit(seriesId)}
        />
      )}
    </div>
  );
}

/** /live — free news streams played from the broadcasters' own YouTube
    channels (official embeds: owners keep ads, branding and control). */
function LiveView() {
  const [channels, setChannels] = useState<LiveChannel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listLive()
      .then((rows) => {
        if (!cancelled) setChannels(rows);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "live failed to load");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = channels?.find((c) => c.id === selectedId) ?? null;

  const initials = (name: string) =>
    name.split(/\s+/).slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join("");

  return (
    <div className="live" data-testid="live-view">
      <p className="hero-kicker">Live TV</p>
      <h2 className="tabview-title">Live</h2>
      <p className="muted">Free news streams, played from the broadcasters&apos; official channels.</p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {selected && (
        <section aria-label={`${selected.name} live`} className="live-player-wrap">
          <div className="live-head">
            <div>
              <h3>{selected.name}</h3>
              <p className="muted">{selected.category} · live from YouTube</p>
            </div>
            <button type="button" onClick={() => setSelectedId(null)}>
              Close
            </button>
          </div>
          <div className="live-player">
            <iframe
              key={selected.id}
              src={`https://www.youtube.com/embed/live_stream?channel=${encodeURIComponent(selected.youtube_channel_id)}&autoplay=1&rel=0`}
              title={`${selected.name} live`}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
              data-testid="live-iframe"
            />
          </div>
        </section>
      )}
      {channels === null && !error && <p className="muted">loading channels…</p>}
      {channels !== null && channels.length === 0 && (
        <div className="empty-panel">
          <p>No live channels programmed yet.</p>
        </div>
      )}
      {channels !== null && channels.length > 0 && (
        <ul className="results-grid">
          {channels.map((c) => (
            <li key={c.id} className="result-card">
              <button
                type="button"
                onClick={() => {
                  setSelectedId(c.id);
                  window.setTimeout(() => {
                    document.querySelector(".live-player-wrap")?.scrollIntoView({ behavior: "smooth" });
                  }, 50);
                }}
                data-testid={`live-channel-${c.id}`}
              >
                <span className="rail-poster" aria-hidden="true">
                  {initials(c.name)}
                </span>
                <span className="rail-title">{c.name}</span>
                <span className="badge">{c.category}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Tab page (anime, movies, shows): sidebar filters + poster wall. */
function MediaTabView({ kicker, title, subtitle, items, onOpen, genre, sortMode, onClearFilters, onPickGenre, onPickSort }: MediaTabViewProps) {
  const visible = useMemo(() => {
    const filtered = genre ? items.filter((i) => i.genres.includes(genre)) : items;
    if (sortMode === "popular") {
      return [...filtered].sort((a, b) => (b.popularity ?? -1) - (a.popularity ?? -1));
    }
    if (sortMode === "top") {
      return [...filtered].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    }
    return filtered;
  }, [items, genre, sortMode]);
  const genres = useMemo(() => topGenres(items, 14).map((g) => g.genre), [items]);
  const unfiltered = !genre && !sortMode;
  const allLabel = `All ${title}`;
  return (
    <div className="tabview tabview-side">
      <aside className="tab-side" aria-label={`Filter ${title}`}>
        <button
          type="button"
          aria-current={unfiltered ? "page" : undefined}
          className={unfiltered ? "tab-side-active" : ""}
          onClick={onClearFilters}
        >
          <SideIcon name="browse" />
          <span>{allLabel}</span>
        </button>
        <button
          type="button"
          aria-current={sortMode === "popular" && !genre ? "page" : undefined}
          className={sortMode === "popular" ? "tab-side-active" : ""}
          onClick={() => onPickSort("popular")}
        >
          <SideIcon name="flame" />
          <span>Popular</span>
        </button>
        <button
          type="button"
          aria-current={sortMode === "top" && !genre ? "page" : undefined}
          className={sortMode === "top" ? "tab-side-active" : ""}
          onClick={() => onPickSort("top")}
        >
          <SideIcon name="star" />
          <span>Top Rated</span>
        </button>
        <p className="tab-genres-label">Genres</p>
        {genres.map((g) => (
          <button
            key={g}
            type="button"
            aria-current={genre === g ? "page" : undefined}
            className={genre === g ? "tab-side-active" : ""}
            onClick={() => onPickGenre(g)}
          >
            <SideIcon name="tag" />
            <span>{g}</span>
          </button>
        ))}
      </aside>
      <div className="tab-main">
        <p className="hero-kicker">{kicker}</p>
        <h2 className="tabview-title">{sortMode === "popular" ? "Popular" : sortMode === "top" ? "Top Rated" : allLabel}</h2>
        <p className="muted">{genre ?? subtitle}</p>
        {visible.length === 0 ? (
          <div className="empty-panel">
            <p>No titles{genre ? ` tagged “${genre}”` : ""} here yet.</p>
            <button type="button" onClick={onClearFilters}>
              Show everything
            </button>
          </div>
        ) : (
          <ul className="tab-grid" data-testid={`tab-grid-${title.toLowerCase()}`}>
            {visible.map((item) => (
              <li key={item.id} className="result-card">
                <button type="button" onClick={() => onOpen(item.id)}>
                  <Artwork
                    title={item.title}
                    src={item.poster_key}
                    hue={hueFor(item.id)}
                    className="rail-poster"
                    imgClassName="rail-img"
                  />
                  <span className="rail-title">{item.title}</span>
                  <span className="muted credit-sub">
                    {[item.year ?? null, item.score !== null && item.score !== undefined ? `★ ${item.score.toFixed(1)}` : null]
                      .filter((x): x is string | number => x !== null)
                      .join(" · ") || " "}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function App() {
  const [route, setRoute] = useState<Route>(() => routeOf(window.location.pathname));
  const [user, setUser] = useState<SessionUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [partyCode, setPartyCode] = useState<string | null>(null);  const [loginEmail, setLoginEmail] = useState("demo@libre.tv");
  const [loginPassword, setLoginPassword] = useState("demo-pass-2026");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [sideOpen, setSideOpen] = useState(false);
  const [sideTime, setSideTime] = useState("");
  const [authTab, setAuthTab] = useState<"signin" | "register">("signin");
  const [registerName, setRegisterName] = useState("");
  const [registerEmail, setRegisterEmail] = useState("");
  const [registerPassword, setRegisterPassword] = useState("");
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [registerBusy, setRegisterBusy] = useState(false);
  const [sessionExpires, setSessionExpires] = useState<number | null>(null);

  const [catalog, setCatalog] = useState<MediaListItem[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MediaDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [personId, setPersonId] = useState<string | null>(null);
  const [person, setPerson] = useState<PersonDetail | null>(null);
  const [personError, setPersonError] = useState<string | null>(null);
  const [personLoading, setPersonLoading] = useState(false);
  /** Return path for the person back button (title page or search). */
  const [personReturnPath, setPersonReturnPath] = useState<string | null>(null);
  const [heroIndex, setHeroIndex] = useState(0);
  /** Slide direction of the hero: +1 content glides in from the right, -1 from the left. */
  const [slideDir, setSlideDir] = useState<1 | -1>(1);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResultItem[]>([]);
  const [resultsQuery, setResultsQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const searchAbort = useRef<AbortController | null>(null);
  const activeSource = usePlayerStore((state) => state.activeSource);
  const [resumeAt, setResumeAt] = useState<number | undefined>(undefined);

  const [continueWatching, setContinueWatching] = useState<ContinueEntry[]>(() =>
    readContinueWatching(),
  );
  const [subTracks, setSubTracks] = useState<Array<{ id: string; language: string; url: string }>>([]);
  const [rotateHero, setRotateHero] = useState<boolean>(() => readRotateHero());
  const [theme, setTheme] = useState<ThemePreference>(() => readTheme());
  const [serverOrder, setServerOrder] = useState<ServerProvider[]>(() => readServerOrder());
  const providerByIdRef = useRef(new Map<string, string>());
  const [followedIds, setFollowedIds] = useState<string[]>(() => readFollowedPeople());
  const [notifOpen, setNotifOpen] = useState(false);
  const [followedInfo, setFollowedInfo] = useState<Array<{ id: string; name: string; latest: string | null }>>([]);
  const [desktopAlerts, setDesktopAlerts] = useState(() => {
    try {
      return localStorage.getItem("libre:desktop-alerts") === "true";
    } catch {
      return false;
    }
  });
  const [alertNote, setAlertNote] = useState<string | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [bookmarkIds, setBookmarkIds] = useState<ReadonlySet<string>>(new Set());
  // playback URL -> { assetId, title, episodeId } for progress tracking.
  const trackMeta = useRef(new Map<string, { assetId: string; title: string; episodeId?: string }>());

  const railRef = useRef<HTMLUListElement | null>(null);
  const cwRailRef = useRef<HTMLUListElement | null>(null);
  const navRef = useRef<HTMLElement | null>(null);
  // Lift the home hero up behind the floating nav so no black band shows.
  // Measured (nav height varies with wrapping), CSS var consumed by .hero.
  const [navLift, setNavLift] = useState(0);

  useEffect(() => {
    const measure = () => {
      const h = navRef.current?.offsetHeight ?? 0;
      setNavLift(h > 0 ? h + 20 : 0);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  // Tiny history router: home, tabs, account, library, calendar, settings, tv,
  // anime, movies, shows, parties, title pages, person pages. Unknown paths
  // render the 404 view. Query strings (?genre=, ?sort=) are preserved for
  // tab filters and tracked in locationSearch.
  const [locationSearch, setLocationSearch] = useState(() => window.location.search);
  const navigate = useCallback((path: string) => {
    const [pathname, query] = [path.split("?")[0] ?? path, path.includes("?") ? `?${path.split("?").slice(1).join("?")}` : ""];
    if (window.location.pathname + window.location.search !== path) {
      window.history.pushState(null, "", path);
    }
    setRoute(routeOf(pathname));
    setLocationSearch(query);
    setSelectedId(null);
    setDetail(null);
    setPersonId(null);
    setPerson(null);
    setPersonReturnPath(null);
    window.scrollTo({ top: 0 });
  }, []);

  // Deep-link sync: mount + back/forward buttons resolve /title/:id and
  // /person/:id into loaded views without pushing new history entries.
  useEffect(() => {
    const sync = () => {
      const p = window.location.pathname;
      if (p.startsWith("/title/")) {
        const id = idAfter(p, "/title/");
        if (id) {
          setRoute("/title");
          void loadTitle(id);
          return;
        }
      }
      if (p.startsWith("/person/")) {
        const id = idAfter(p, "/person/");
        if (id) {
          setRoute("/person");
          void loadPerson(id, null);
          return;
        }
      }
      setRoute(routeOf(p));
      setLocationSearch(window.location.search);
      setSelectedId(null);
      setDetail(null);
      setPersonId(null);
      setPerson(null);
      setPersonReturnPath(null);
      window.scrollTo({ top: 0 });
    };
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  // Session (cookie is HttpOnly; the browser attaches it automatically).
  useEffect(() => {
    let cancelled = false;
    getSession()
      .then((payload) => {
        if (cancelled) return;
        if (payload.authenticated) {
          setUser(payload.user);
          setSessionExpires(payload.expires_at);
          void refreshBookmarks();
        }
      })
      .catch(() => {
        // Logged out — catalog still loads (free items stay visible).
      })
      .finally(() => {
        if (!cancelled) setAuthChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Catalog for the hero + rails.
  const refreshCatalog = useCallback(async () => {
    try {
      setCatalog(await listMedia());
      setCatalogError(null);
    } catch (err: unknown) {
      setCatalogError(err instanceof Error ? err.message : "catalog failed to load");
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  const refreshBookmarks = useCallback(async () => {
    try {
      const items = await listBookmarks();
      setBookmarkIds(new Set(items.map((b) => b.episode_id)));
    } catch {
      setBookmarkIds(new Set());
    }
  }, []);

  const toggleBookmark = useCallback(
    async (episodeId: string) => {
      if (!user) return;
      const wasOn = bookmarkIds.has(episodeId);
      // Optimistic flip; revert on failure.
      setBookmarkIds((prev) => {
        const next = new Set(prev);
        if (wasOn) next.delete(episodeId);
        else next.add(episodeId);
        return next;
      });
      try {
        if (wasOn) await removeBookmark(episodeId);
        else await addBookmark(episodeId);
      } catch {
        setBookmarkIds((prev) => {
          const next = new Set(prev);
          if (wasOn) next.add(episodeId);
          else next.delete(episodeId);
          return next;
        });
      }
    },
    [user, bookmarkIds],
  );

  const setRotateHeroPersisted = useCallback((value: boolean) => {
    setRotateHero(value);
    try {
      localStorage.setItem("libre:prefs", JSON.stringify({ rotate: value }));
    } catch {
      // Private mode — rotation simply won't persist.
    }
  }, []);

  const setThemePersisted = useCallback((value: ThemePreference) => {
    setTheme(value);
    applyTheme(value);
    try {
      localStorage.setItem("libre:theme", value);
    } catch {
      // Private mode — the choice still applies for this session.
    }
  }, []);

  const setServerOrderPersisted = useCallback((order: ServerProvider[]) => {
    setServerOrder(order);
    try {
      localStorage.setItem("libre:server-order", JSON.stringify(order));
    } catch {
      // Private mode — the order still applies for this session.
    }
  }, []);

  const sourceLabelForPlayer = useCallback(
    (id: string, index: number) => providerByIdRef.current.get(id) ?? assetLabel(id, index),
    [],
  );

  const toggleFollowPerson = useCallback((id: string) => {
    setFollowedIds((current) => {
      const isFollowing = current.includes(id);
      const next = isFollowing ? current.filter((value) => value !== id) : [...current, id];
      try {
        localStorage.setItem("libre:followed-people", JSON.stringify(next));
      } catch {
        // Private mode — the choice still applies for this session.
      }
      return next;
    });
  }, []);

  // Resolve followed person ids to names/latest credit when the panel opens.
  useEffect(() => {
    if (!notifOpen) return;
    let cancelled = false;
    void Promise.all(
      followedIds.map(async (id) => {
        try {
          const person = await getPersonDetail(id);
          return { id, name: person.name, latest: person.credits[0]?.title ?? null };
        } catch {
          return { id, name: id, latest: null };
        }
      }),
    ).then((items) => {
      if (!cancelled) setFollowedInfo(items);
    });
    return () => {
      cancelled = true;
    };
  }, [notifOpen, followedIds]);

  const enableAlerts = async () => {
    if (desktopAlerts) {
      setAlertNote("Desktop alerts are already on for this browser.");
      return;
    }
    if (!("Notification" in window)) {
      setAlertNote("This browser doesn't support desktop alerts.");
      return;
    }
    try {
      const permission = await Notification.requestPermission();
      if (permission === "granted") {
        setDesktopAlerts(true);
        localStorage.setItem("libre:desktop-alerts", "true");
        setAlertNote("Desktop alerts enabled. We'll ping you when a new episode drops.");
        try {
          new Notification("Libre", { body: "Notifications are on. You're all set." });
        } catch {
          // Some browsers block constructor notifications; permission still counts.
        }
      } else {
        setAlertNote("Permission denied — you can allow notifications in browser settings.");
      }
    } catch {
      setAlertNote("Couldn't request notification permission in this browser.");
    }
  };

  // "System" follows the OS setting live, not just at page load.
  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  const clearWatching = useCallback(() => {
    try {
      localStorage.removeItem(CW_KEY);
    } catch {
      // Ignored.
    }
    setContinueWatching([]);
  }, []);

  useEffect(() => {
    void refreshCatalog();
  }, [refreshCatalog]);

  // Continue Watching progress tracker (5s cadence + pause).
  useEffect(() => {
    const persist = () => {
      const state = usePlayerStore.getState();
      if (!state.activeSource || !state.isPlaying) return;
      if (!Number.isFinite(state.currentTime) || state.currentTime <= 5) return;
      const meta = trackMeta.current.get(state.activeSource.url);
      if (!meta) return;
      try {
        const raw = localStorage.getItem(CW_KEY);
        const all = (raw ? JSON.parse(raw) : {}) as Record<string, ContinueEntry>;
        all[meta.assetId] = {
          assetId: meta.assetId,
          title: meta.title,
          episodeId: meta.episodeId,
          position: state.currentTime,
          duration: Number.isFinite(state.duration) ? state.duration : 0,
          updatedAt: Date.now(),
        };
        localStorage.setItem(CW_KEY, JSON.stringify(all));
        setContinueWatching(readContinueWatching());
      } catch {
        // Storage full/blocked — Continue Watching simply stays stale.
      }
    };
    const timer = window.setInterval(persist, 5000);
    return () => window.clearInterval(timer);
  }, []);

  const heroOrder = useMemo(() => {
    if (catalog.length === 0) return [] as MediaListItem[];
    // Playable first, capped at 8 titles so the billboard stays a tight rotation.
    return [...catalog]
      .sort((a, b) => Number(b.playable) - Number(a.playable))
      .slice(0, 8);
  }, [catalog]);

  const featured = useMemo(() => {
    if (heroOrder.length === 0) return null;
    return heroOrder[heroIndex % heroOrder.length] ?? null;
  }, [heroOrder, heroIndex]);

  /** Direction-aware hero navigation: forward slides in from the right, back from the left.
      Compares the raw target (pre-modulo) so wraparound auto-advance keeps gliding forward. */
  const goHero = useCallback(
    (target: number) => {
      const count = heroOrder.length;
      if (count === 0) return;
      const t = ((target % count) + count) % count;
      if (t === heroIndex) return;
      setSlideDir(target > heroIndex ? 1 : -1);
      setHeroIndex(t);
    },
    [heroOrder.length, heroIndex],
  );

  // Hero rotation (paused for reduced-motion users or when disabled in settings).
  useEffect(() => {
    if (heroOrder.length < 2) return;
    if (!rotateHero) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = window.setInterval(() => goHero(heroIndex + 1), 9000);
    return () => window.clearInterval(timer);
  }, [heroOrder.length, heroIndex, goHero, rotateHero]);

  const runLogin = async () => {
    setLoginError(null);
    setLoginBusy(true);
    try {
      const payload = await login(loginEmail.trim(), loginPassword);
      if (!payload.authenticated || !payload.user) {
        setLoginError("login failed");
        return;
      }
      setUser(payload.user);
      setAuthOpen(false);
      try {
        const session = await getSession();
        if (session.authenticated) setSessionExpires(session.expires_at);
      } catch {
        // Non-fatal: expiry line stays hidden.
      }
      await refreshBookmarks();
      await refreshCatalog();
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : "login failed");
    } finally {
      setLoginBusy(false);
    }
  };

  const runLogout = async () => {
    try {
      await logout();
    } catch {
      // Cookie may already be gone; still clear local state.
    }
    setUser(null);
    setSessionExpires(null);
    setBookmarkIds(new Set());
    setSubTracks([]);
    setSelectedId(null);
    setDetail(null);
    setResumeAt(undefined);
    usePlayerStore.getState().setActiveSource(null);
    await refreshCatalog();
  };

  const runRegister = async () => {
    setRegisterError(null);
    setRegisterBusy(true);
    try {
      const payload = await register(
        registerEmail.trim(),
        registerPassword,
        registerName.trim() || null,
      );
      if (!payload.authenticated || !payload.user) {
        setRegisterError("registration failed");
        return;
      }
      setUser(payload.user);
      setAuthOpen(false);
      try {
        const session = await getSession();
        if (session.authenticated) setSessionExpires(session.expires_at);
      } catch {
        // Non-fatal: expiry line stays hidden.
      }
      await refreshBookmarks();
      await refreshCatalog();
    } catch (err) {
      setRegisterError(err instanceof Error ? err.message : "registration failed");
    } finally {
      setRegisterBusy(false);
    }
  };

  const openAuth = (tab: "signin" | "register") => {
    setAuthTab(tab);
    setLoginError(null);
    setRegisterError(null);
    setAuthOpen(true);
  };

  // Escape closes the auth modal / sidebar.
  useEffect(() => {
    if (!authOpen && !sideOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setAuthOpen(false);
        setSideOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [authOpen, sideOpen]);

  const openSidebar = useCallback(() => {
    setSideTime(
      new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
    );
    setSideOpen(true);
  }, []);

  const goContinue = useCallback(() => {
    setSideOpen(false);
    if (route !== "/") {
      navigate("/");
      window.setTimeout(() => {
        const el =
          document.getElementById("continue") ?? document.getElementById("browse");
        el?.scrollIntoView({ behavior: "smooth" });
      }, 80);
      return;
    }
    const el = document.getElementById("continue") ?? document.getElementById("browse");
    el?.scrollIntoView({ behavior: "smooth" });
  }, [route, navigate]);

  /** Every playback entry point goes to the watch theater (/watch/...).
      Resolves the title for its watch URL; falls back to inline playback only
      when unresolvable (legacy history without episode ids). */
  const openWatch = useCallback(async (opts: {
    seriesId?: string;
    episodeId?: string;
    startAt?: number;
    onFallback?: () => void;
  }) => {
    const { seriesId, episodeId, startAt, onFallback } = opts;
    const key = seriesId ?? episodeId;
    if (key) {
      try {
        const d = await getMediaDetail(key);
        if (d.watch_url) {
          const qs = new URLSearchParams();
          if (episodeId) qs.set("ep", episodeId);
          if (startAt !== undefined && Number.isFinite(startAt) && startAt > 5) {
            qs.set("t", String(Math.floor(startAt)));
          }
          const suffix = qs.toString();
          navigate(suffix ? `${d.watch_url}?${suffix}` : d.watch_url);
          return;
        }
      } catch {
        // Fall through to inline playback below.
      }
    }
    onFallback?.();
  }, [navigate]);

  /** Load title data without touching history (deep links, back/forward). */
  const loadTitle = useCallback(async (id: string) => {
    setSelectedId(id);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    setPersonId(null);
    setPerson(null);
    try {
      setDetail(await getMediaDetail(id));
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : "could not load details");
    } finally {
      setDetailLoading(false);
    }
    window.scrollTo({ top: 0 });
  }, []);

  /** Open a title page (clicking a movie/show/card/search result). */
  const navigateTitle = useCallback((id: string) => {
    const path = `/title/${encodeURIComponent(id)}`;
    if (window.location.pathname !== path) window.history.pushState(null, "", path);
    setRoute("/title");
    setPersonReturnPath(null);
    void loadTitle(id);
  }, [loadTitle]);

  /** Load person data without touching history. */
  const loadPerson = useCallback(async (id: string, returnPath: string | null) => {
    setPersonId(id);
    setPerson(null);
    setPersonError(null);
    setPersonLoading(true);
    setPersonReturnPath(returnPath);
    try {
      setPerson(await getPersonDetail(id));
    } catch (err) {
      setPersonError(err instanceof Error ? err.message : "could not load person");
    } finally {
      setPersonLoading(false);
    }
    window.scrollTo({ top: 0 });
  }, []);

  /** Open a person page (cast member or search result). returnPath is where
      Back goes: a title path or "/search" (query + results survive in state). */
  const navigatePerson = useCallback((id: string, returnPath: string | null) => {
    const path = `/person/${encodeURIComponent(id)}`;
    if (window.location.pathname !== path) window.history.pushState(null, "", path);
    setRoute("/person");
    void loadPerson(id, returnPath);
  }, [loadPerson]);

  // Playback source list: every playable rendition for the episode becomes a
  // selectable source; fatal player errors auto-advance through it.
  const [srcList, setSrcList] = useState<string[]>([]);
  const [srcIndex, setSrcIndex] = useState(0);
  const srcRef = useRef({ list: [] as string[], index: 0 });
  useEffect(() => {
    srcRef.current = { list: srcList, index: srcIndex };
  }, [srcList, srcIndex]);

  const playAsset = useCallback(
    (assetId: string, title?: string, startAt?: number, episodeId?: string, assets?: string[]) => {
      setError(null);
      // Map each playable rendition to a server slot, then order the slots by
      // the user's saved preference. Reordering changes failover priority.
      const ranked = (assets && assets.length > 0 ? assets : [assetId]).map((id, slot) => ({ id, slot }));
      ranked.sort((a, b) => {
        const pa = SERVER_PROVIDERS[a.slot % SERVER_PROVIDERS.length];
        const pb = SERVER_PROVIDERS[b.slot % SERVER_PROVIDERS.length];
        return serverOrder.indexOf(pa) - serverOrder.indexOf(pb);
      });
      const list = ranked.map((entry) => entry.id);
      providerByIdRef.current = new Map(
        ranked.map((entry) => [entry.id, SERVER_PROVIDERS[entry.slot % SERVER_PROVIDERS.length]]),
      );
      const url = playbackUrl(list[0]!);
      if (title) trackMeta.current.set(url, { assetId: list[0]!, title, episodeId });
      setResumeAt(startAt);
      // Subtitles ride the episode (empty while anonymous or untracked).
      setSubTracks([]);
      if (episodeId) {
        listSubtitles(episodeId)
          .then((payload) =>
            setSubTracks(
              payload.subtitles.map((t) => ({
                id: t.id,
                language: t.language,
                url: subtitleFileUrl(t.id),
              })),
            ),
          )
          .catch(() => {
            // No subtitles — playback continues without tracks.
          });
      }
      setSrcList(list);
      setSrcIndex(0);
    },
    [serverOrder],
  );

  // The active source follows the source list: picking another rendition or
  // auto-failover just moves the index.
  useEffect(() => {
    const id = srcList[srcIndex];
    if (!id) return;
    usePlayerStore.getState().setActiveSource({ type: "hls", url: playbackUrl(id) });
    window.setTimeout(() => {
      document.getElementById("player")?.scrollIntoView({ behavior: "smooth" });
    }, 50);
  }, [srcList, srcIndex]);

  /** Advance to the next source (auto-failover); errors when none remain. */
  const advanceSource = useCallback(() => {
    const { list, index } = srcRef.current;
    if (index + 1 < list.length) {
      setSrcIndex(index + 1);
    } else {
      setError("all sources failed for this title");
      usePlayerStore.getState().setActiveSource(null);
    }
  }, []);

  const shufflePlay = useCallback(async () => {
    const playable = catalog.filter((c) => c.playable);
    const pool = playable.length > 0 ? playable : catalog;
    if (pool.length === 0) {
      setError("nothing to play yet");
      return;
    }
    const pick = pool[Math.floor(Math.random() * pool.length)]!;
    await openWatch({ seriesId: pick.id });
  }, [catalog, openWatch]);

  const doSearch = useCallback(async (q: string) => {
    const term = q.trim();
    if (!term) {
      searchAbort.current?.abort();
      setResults([]);
      setResultsQuery("");
      setError(null);
      setHasSearched(false);
      setLoading(false);
      return;
    }
    searchAbort.current?.abort();
    const controller = new AbortController();
    searchAbort.current = controller;
    setError(null);
    setLoading(true);
    try {
      const payload = await searchMedias(term, controller.signal);
      setResults(payload.results);
      setResultsQuery(term);
      setHasSearched(true);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "search failed");
      setResults([]);
      setResultsQuery(term);
      setHasSearched(true);
    } finally {
      if (searchAbort.current === controller) setLoading(false);
    }
  }, []);

  const runSearch = () => {
    void doSearch(query);
  };

  // Live search-as-you-type (350ms debounce, in-flight requests cancelled).
  useEffect(() => {
    const term = query.trim();
    if (!term) {
      searchAbort.current?.abort();
      setResults([]);
      setError(null);
      setHasSearched(false);
      setLoading(false);
      return;
    }
    const timer = window.setTimeout(() => {
      void doSearch(term);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [query, doSearch]);

  const scrollTo = (id: string) =>
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });

  const goBrowse = useCallback(() => {
    if (route !== "/") {
      navigate("/");
      // Let the home view mount before scrolling to its rail.
      window.setTimeout(() => {
        document.getElementById("browse")?.scrollIntoView({ behavior: "smooth" });
      }, 80);
      return;
    }
    scrollTo("browse");
  }, [route, navigate]);

  const slideRail = (ref: React.RefObject<HTMLUListElement | null>, dir: 1 | -1) => {
    const el = ref.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: "smooth" });
  };

  // Footer-driven tab filters (?genre= / ?sort= on /movies and /shows).
  const tabQuery = new URLSearchParams(locationSearch);
  const tabGenre = route === "/movies" || route === "/shows" ? tabQuery.get("genre") : null;
  const tabSortRaw = route === "/movies" || route === "/shows" ? tabQuery.get("sort") : null;
  const tabSort: "popular" | "top" | null =
    tabSortRaw === "popular" || tabSortRaw === "top" ? tabSortRaw : null;
  const clearTabFilters = () => navigate(route === "/shows" ? "/shows" : "/movies");

  /** Most frequent genres in a catalog slice (footer link clouds). */
  const footerGenres = (kinds: string[], limit = 14): string[] => {
    const counts = new Map<string, number>();
    for (const item of catalog) {
      if (!kinds.includes(item.kind)) continue;
      for (const g of item.genres) counts.set(g, (counts.get(g) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([g]) => g);
  };
  const movieFooterGenres = footerGenres(["movie"]);
  const showFooterGenres = footerGenres(["tv", "series"]);

  // Search splits into a people row + title poster cards (dulo-style).
  const peopleHits = results.filter((r) => r.type === "person");
  const titleHits = results.filter((r) => r.type !== "person");

  return (
    <div className="stream">
      {route !== "/watch" && (
      <nav className="pill-nav" aria-label="Primary" ref={navRef}>
        <button type="button" className="brand" onClick={() => navigate("/")}>
          <span className="brand-mark" aria-hidden="true">L</span>
          <span className="brand-name">Libre</span>
        </button>
        <button type="button" onClick={() => navigate("/")} aria-current={route === "/" ? "page" : undefined}><SideIcon name="home" /><span>Home</span></button>
        <button type="button" onClick={goBrowse}><SideIcon name="browse" /><span>Browse</span></button>
        <button type="button" onClick={() => navigate("/search")} aria-current={route === "/search" ? "page" : undefined}><SideIcon name="search" /><span>Search</span></button>
        <span className="nav-spacer" />
        <div className="notif-wrap">
          <button
            type="button"
            className={`notif-btn${notifOpen ? " notif-open" : ""}`}
            aria-label="Notifications"
            aria-expanded={notifOpen}
            data-testid="notifications-button"
            onClick={() => setNotifOpen((open) => !open)}
          >
            <BellIcon size={18} />
            {followedIds.length > 0 && <span className="notif-dot" aria-hidden="true" />}
          </button>
          {notifOpen && (
            <div className="notif-panel" role="dialog" aria-label="Notifications" data-testid="notifications-panel">
              <div className="notif-head">
                <strong>New this week</strong>
                <span>Curated from your lists</span>
              </div>
              <div className="notif-alert-row">
                <div>
                  <strong>Get desktop alerts</strong>
                  <span>Be pinged when a new episode drops.</span>
                </div>
                <button
                  type="button"
                  className={desktopAlerts ? "alert-enabled" : ""}
                  onClick={() => void enableAlerts()}
                  data-testid="alert-enable"
                >
                  {desktopAlerts ? "✓ Enabled" : "Enable"}
                </button>
              </div>
              <div className="notif-body">
                {followedInfo.length === 0 ? (
                  <div className="notif-empty">
                    <BellIcon size={30} />
                    <p>
                      Nothing new from your lists or the people you follow. We'll let you know when there is.
                    </p>
                  </div>
                ) : (
                  <ul className="notif-list">
                    {followedInfo.map((item) => (
                      <li key={item.id}>
                        <button
                          type="button"
                          onClick={() => {
                            setNotifOpen(false);
                            navigatePerson(item.id, window.location.pathname);
                          }}
                        >
                          <span className="notif-list-icon"><BellIcon size={15} /></span>
                          <span>
                            <strong>{item.name}</strong>
                            <span>{item.latest ? `Latest: ${item.latest}` : "Following"}</span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {alertNote && <p className="notif-note">{alertNote}</p>}
            </div>
          )}
        </div>
        <div className="auth-bar" data-testid="auth-bar">
          {!authChecked ? (
            <span className="muted">…</span>
          ) : user ? (
            <button
              type="button"
              className="profile-pill"
              data-testid="profile-button"
              onClick={() => navigate("/account")}
              aria-label={`Account: ${user.display_name ?? user.email}`}
            >
              <span
                className="avatar"
                aria-hidden="true"
                style={{ "--avatar-hue": hueFor(user.id) } as React.CSSProperties}
              >
                {(user.display_name ?? user.email).charAt(0).toUpperCase()}
              </span>
              <span className="profile-name" data-testid="user-badge">
                {user.display_name ?? user.email}
              </span>
            </button>
          ) : (
            <button
              type="button"
              className="profile-pill profile-signin"
              data-testid="profile-button"
              onClick={() => openAuth("signin")}
            >
              <span className="avatar avatar-guest" aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <circle cx="8" cy="5.2" r="2.8" fill="currentColor" />
                  <path
                    d="M2.2 13.4c.7-2.9 3.1-4.4 5.8-4.4s5.1 1.5 5.8 4.4c.1.5-.2.9-.7.9H2.9c-.5 0-.8-.4-.7-.9Z"
                    fill="currentColor"
                  />
                </svg>
              </span>
              <span className="profile-name">Sign in</span>
            </button>
          )}
        </div>
      </nav>
      )}

      {route !== "/watch" && (
      <div
        className="side"
        data-open={sideOpen}
        onMouseLeave={() => setSideOpen(false)}
      >
        <button
          type="button"
          className="side-handle"
          aria-label={sideOpen ? "Close navigation" : "Open navigation"}
          aria-expanded={sideOpen}
          data-testid="side-handle"
          onMouseEnter={() => {
            if (!sideOpen) openSidebar();
          }}
          onClick={() => {
            if (sideOpen) setSideOpen(false);
            else openSidebar();
          }}
        />
        <aside
          className="side-panel"
          aria-label="Site"
          aria-hidden={!sideOpen}
          data-testid="side-panel"
        >
          <div className="side-user">
            {user ? (
              <>
                <span
                  className="avatar"
                  aria-hidden="true"
                  style={{ "--avatar-hue": hueFor(user.id) } as React.CSSProperties}
                >
                  {(user.display_name ?? user.email).charAt(0).toUpperCase()}
                </span>
                <span className="side-username">{user.display_name ?? user.email}</span>
                <span className="side-time">{sideTime}</span>
              </>
            ) : (
              <>
                <span className="avatar avatar-guest" aria-hidden="true">?</span>
                <span className="side-username">Guest</span>
                <button
                  type="button"
                  className="side-signin"
                  onClick={() => {
                    setSideOpen(false);
                    openAuth("signin");
                  }}
                >
                  Sign in
                </button>
              </>
            )}
          </div>
          <nav className="side-nav" aria-label="Sections">
            {[
              { label: "Home", icon: "home", current: route === "/", run: () => navigate("/") },
              { label: "Browse", icon: "browse", current: false, run: () => { setSideOpen(false); goBrowse(); } },
              { label: "Movies", icon: "film", current: route === "/movies", run: () => navigate("/movies") },
              { label: "Shows", icon: "monitor", current: route === "/shows", run: () => navigate("/shows") },
              { label: "Anime", icon: "sparkles", current: route === "/anime", run: () => navigate("/anime") },
              { label: "Search", icon: "search", current: route === "/search", run: () => navigate("/search") },
              { label: "Live", icon: "broadcast", current: route === "/live", run: () => navigate("/live") },
              { label: "Continue Watching", icon: "continue", current: false, run: goContinue },
              { label: "Discover", icon: "discover", current: false, run: () => void shufflePlay() },
              { label: "Library", icon: "library", current: route === "/library", run: () => navigate("/library") },
              { label: "Calendar", icon: "calendar", current: route === "/calendar", run: () => navigate("/calendar") },
              { label: "Your Libre", icon: "user", current: route === "/account", run: () => navigate("/account") },
              { label: "Watch Parties", icon: "users", current: route === "/parties", run: () => { setPartyCode(null); navigate("/parties"); } },
            ].map((item) => (
              <button
                key={item.label}
                type="button"
                onClick={() => {
                  setSideOpen(false);
                  item.run();
                }}
                aria-current={item.current ? "page" : undefined}
              >
                <SideIcon name={item.icon} />
                <span>{item.label}</span>
              </button>
            ))}
          </nav>
          <p className="side-heading">More</p>
          <nav className="side-nav" aria-label="More">
            {[
              { label: "TV Mode", icon: "tv", current: route === "/tv", run: () => navigate("/tv") },
              { label: "Settings", icon: "settings", current: route === "/settings", run: () => navigate("/settings") },
            ].map((item) => (
              <button
                key={item.label}
                type="button"
                onClick={() => {
                  setSideOpen(false);
                  item.run();
                }}
                aria-current={item.current ? "page" : undefined}
              >
                <SideIcon name={item.icon} />
                <span>{item.label}</span>
              </button>
            ))}
          </nav>
          <p className="side-heading">Soon</p>
          <nav className="side-nav" aria-label="Coming soon">
            {[
              { label: "Shorts", icon: "zap" },
            ].map((item) => (
              <button key={item.label} type="button" disabled title="Not in the demo catalog yet">
                <SideIcon name={item.icon} />
                <span>{item.label}</span>
                <span className="badge">Soon</span>
              </button>
            ))}
          </nav>
          {user && (
            <button
              type="button"
              className="side-signout"
              onClick={() => {
                setSideOpen(false);
                void runLogout();
              }}
            >
              <SideIcon name="logout" />
              <span>Log out</span>
            </button>
          )}
        </aside>
      </div>
      )}

      {route === "/" && featured && (
        <header
          className="hero"
          style={{ "--hero-hue": hueFor(featured.id), "--nav-lift": `${navLift}px` } as React.CSSProperties}
        >
          <span className="hero-watermark" aria-hidden="true">
            {featured.title.charAt(0).toUpperCase()}
          </span>
          <HeroPhoto key={`photo-${featured.id}`} src={featured.fanart_key} />
          <div className="hero-body hero-slide" data-dir={slideDir} key={featured.id}>
            <p className="hero-kicker">Featured</p>
            <HeroTitle title={featured.title} logo={featured.logo_key} />
            {featured.overview && <p className="hero-overview">{featured.overview}</p>}
            <div className="hero-actions">
              <button
                type="button"
                className="btn-primary"
                onClick={() => void openWatch({ seriesId: featured.id })}
              >
                ▶ Watch Now
              </button>
              <button type="button" onClick={() => navigateTitle(featured.id)}>
                ⓘ More Info
              </button>
            </div>
          </div>
          {heroOrder.length > 1 && (
            <div className="hero-dots" role="tablist" aria-label="Featured titles">
              {(() => {
                const MAX = 7;
                const n = heroOrder.length;
                let start = 0;
                if (n > MAX) {
                  start = Math.min(
                    Math.max(0, heroIndex - Math.floor(MAX / 2)),
                    n - MAX,
                  );
                }
                return heroOrder.slice(start, start + Math.min(MAX, n)).map((item, k) => {
                  const i = start + k;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="tab"
                      aria-selected={item.id === featured.id}
                      aria-label={item.title}
                      className={`dot ${item.id === featured.id ? "dot-active" : ""}`}
                      onClick={() => goHero(i)}
                    />
                  );
                });
              })()}
            </div>
          )}
      </header>
        )}

      <main>
        {route !== "/search" && error && (
          <p role="alert" className="error route-error" data-testid="route-error">
            {error}
          </p>
        )}
        {route === "/" ? (
          <>
            {catalog.length > 0 && (
          <section aria-label="Tonight on Libre" className="collection-banner" data-testid="collection-banner">
            <div className="collection-copy">
              <h2>Tonight on Libre.</h2>
              <p>Every title in the demo catalog, one banner. Feeling lucky?</p>
              <div className="collection-actions">
                <button type="button" className="btn-primary" onClick={() => void shufflePlay()}>
                  ⇄ Shuffle play
                </button>
                <button type="button" onClick={() => scrollTo("browse")}>
                  Browse all
                </button>
              </div>
            </div>
            <ul className="collection-tiles" aria-hidden="true">
              {catalog.slice(0, 5).map((item) => (
                <li key={item.id}>
                  <Artwork
                    title={item.title}
                    src={item.poster_key}
                    hue={hueFor(item.id)}
                    className="collection-tile"
                    imgClassName="tile-img"
                  />
                  <span className="tile-caption">{item.title}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {continueWatching.length > 0 && (
          <section id="continue" aria-label="Continue Watching" className="rail-section">
            <div className="rail-head">
              <h2>Continue Watching</h2>
            </div>
            <div className="rail-wrap">
              <button type="button" className="rail-edge left" aria-label="Scroll continue watching left" onClick={() => slideRail(cwRailRef, -1)}>
                ‹
              </button>
              <ul className="rail" data-testid="continue-list" ref={cwRailRef}>
              {continueWatching.map((entry) => {
                const pct =
                  entry.duration > 0
                    ? Math.min(100, Math.round((entry.position / entry.duration) * 100))
                    : 0;
                return (
                  <li key={entry.assetId} className="rail-card cw-card" data-testid="continue-item">
                    <button
                      type="button"
                      onClick={() => void openWatch({
                        episodeId: entry.episodeId,
                        startAt: entry.position,
                        onFallback: () => playAsset(entry.assetId, entry.title, entry.position, entry.episodeId),
                      })}
                    >
                      <span
                        className="rail-poster"
                        style={{ "--tile-hue": hueFor(entry.assetId) } as React.CSSProperties}
                        aria-hidden="true"
                      >
                        {entry.title.charAt(0).toUpperCase()}
                      </span>
                      <span className="rail-title">{entry.title}</span>
                      <span className="progress" aria-hidden="true">
                        <span className="progress-fill" style={{ width: `${pct}%` }} />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <button type="button" className="rail-edge right" aria-label="Scroll continue watching right" onClick={() => slideRail(cwRailRef, 1)}>
              ›
            </button>
            </div>
          </section>
        )}

        <section id="browse" aria-label="Browse" className="rail-section">
          <div className="rail-head">
            <h2>Browse the catalog</h2>
          </div>
          <div className="rail-wrap">
            <button type="button" className="rail-edge left" aria-label="Scroll catalog left" onClick={() => slideRail(railRef, -1)}>
              ‹
            </button>
          {catalogError && (
            <p role="alert" className="error" data-testid="catalog-error">
              {catalogError}
            </p>
          )}
          <ul className="rail" data-testid="catalog-list" ref={railRef}>
            {catalog.map((item) => (
              <SeriesCard
                key={item.id}
                item={item}
                loggedIn={!!user}
                onOpen={navigateTitle}
                testid="catalog-item"
              />
            ))}
          </ul>
          <button type="button" className="rail-edge right" aria-label="Scroll catalog right" onClick={() => slideRail(railRef, 1)}>
            ›
          </button>
          </div>
          {catalogLoading && catalog.length === 0 && !catalogError && <p className="muted">loading catalog…</p>}
          {!catalogLoading && catalog.length === 0 && !catalogError && (
            <p className="muted" data-testid="catalog-empty">
              No titles in the catalog yet. Run the import scripts in <code>scripts/</code> to add movies, shows and anime.
            </p>
          )}
        </section>

        <CategoryRail
          id="rail-movies"
          title="Movies"
          items={catalog.filter((c) => c.kind === "movie")}
          loggedIn={!!user}
          onOpen={navigateTitle}
        />
        <CategoryRail
          id="rail-shows"
          title="Shows"
          items={catalog.filter((c) => c.kind === "tv" || c.kind === "series")}
          loggedIn={!!user}
          onOpen={navigateTitle}
        />
        <CategoryRail
          id="rail-anime"
          title="Anime"
          items={catalog.filter((c) => c.kind === "anime")}
          loggedIn={!!user}
          onOpen={navigateTitle}
        />

          </>
        ) : route === "/search" ? (
        <section id="search" aria-label="Search" className="search-section search-page">
          <div className="search-hero">
            <h2>Search</h2>
            <p className="muted">Find movies, shows and people.</p>
          </div>
          <form
            className="search-field"
            onSubmit={(event) => {
              event.preventDefault();
              runSearch();
            }}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <circle cx="9" cy="9" r="6.2" stroke="currentColor" strokeWidth="2" />
              <path d="m13.8 13.8 3.4 3.4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search movies, TV & actors…"
              aria-label="Search movies, TV and actors"
              data-testid="search-input"
            />
            {query.trim() ? (
              <button
                type="button"
                className="search-clear"
                aria-label="Clear search"
                onClick={() => setQuery("")}
                data-testid="search-clear"
              >
                ✕
              </button>
            ) : null}
            <button type="submit" disabled={loading} data-testid="search-button">
              Search
            </button>
          </form>

          {catalog.length > 0 && (
            <ul className="chip-row" aria-label="Suggestions" data-testid="search-chips">
              {catalog.slice(0, 5).map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    data-testid="search-chip"
                    onClick={() => {
                      setQuery(item.title);
                      void doSearch(item.title);
                    }}
                  >
                    {item.title}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {error && (
            <p role="alert" data-testid="search-error">
              {error}
            </p>
          )}

          {loading && <p className="muted">searching…</p>}

          {!loading && hasSearched && results.length === 0 && !error && (
            <p className="muted">No titles match that search yet.</p>
          )}

          {!loading && hasSearched && results.length > 0 && !error && (
            <p className="hero-kicker results-kicker" data-testid="search-results-heading">
              Results for “{resultsQuery}”
            </p>
          )}

          {peopleHits.length > 0 && (
            <ul className="people-row" data-testid="search-people">
              {peopleHits.map((item) => {
                const photo = item.photo_path
                  ? `https://image.tmdb.org/t/p/w185${item.photo_path}`
                  : null;
                return (
                  <li key={`person:${item.media_id}`}>
                    <button
                      type="button"
                      className="person-hit"
                      onClick={() => navigatePerson(item.media_id, "/search")}
                      data-testid="result-item"
                    >
                      {photo ? (
                        <img src={photo} alt={item.title} className="person-hit-photo" loading="lazy" />
                      ) : (
                        <span className="person-hit-photo person-hit-fallback" aria-hidden="true">
                          {item.title.charAt(0).toUpperCase()}
                        </span>
                      )}
                      <span className="person-hit-name">{item.title}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {titleHits.length > 0 && (
            <ul className="results-grid">
              {titleHits.map((item) => (
                <li key={`${item.type}:${item.media_id}`} className="result-card">
                  <button
                    type="button"
                    onClick={() => navigateTitle(item.media_id)}
                    data-testid="result-item"
                  >
                    <Artwork
                      title={item.title}
                      src={item.poster_key}
                      hue={hueFor(item.media_id)}
                      className="rail-poster"
                      imgClassName="rail-img"
                    />
                    <span className="rail-title">{item.title}</span>
                    <span className="muted credit-sub">
                      {[item.year ? String(item.year) : null, item.score !== null && item.score !== undefined ? `★ ${item.score.toFixed(1)}` : null]
                        .filter((x): x is string => x !== null)
                        .join(" · ") || " "}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        ) : route === "/account" ? (
        <AccountView
          user={user}
          authChecked={authChecked}
          catalog={catalog}
          continueWatching={continueWatching}
          sessionExpires={sessionExpires}
          onSignIn={() => openAuth("signin")}
          onLogout={() => void runLogout()}
          onPlay={(assetId, title, startAt, episodeId) => void openWatch({
            episodeId,
            startAt,
            onFallback: () => playAsset(assetId, title, startAt, episodeId),
          })}
          onBrowse={goBrowse}
        />
        ) : null}
        {route === "/library" && (
        <LibraryView
          user={user}
          authChecked={authChecked}
          onSignIn={() => openAuth("signin")}
          onPlaySeriesEpisode={(seriesId, episodeId) => openWatch({ seriesId, episodeId })}
          onBrowse={goBrowse}
        />
        )}
        {route === "/calendar" && (
        <CalendarView
          catalog={catalog}
          onOpen={(seriesId) => navigateTitle(seriesId)}
          onBrowse={goBrowse}
        />
        )}
        {route === "/settings" && (
        <SettingsView
          rotateHero={rotateHero}
          onToggleRotate={setRotateHeroPersisted}
          theme={theme}
          onSelectTheme={setThemePersisted}
          serverOrder={serverOrder}
          onReorderServers={setServerOrderPersisted}
          watchCount={continueWatching.length}
          onClearWatching={clearWatching}
        />
        )}
        {route === "/anime" && (
        <MediaTabView
          kicker="Your Libre"
          title="Anime"
          subtitle="Every anime in your catalog, ranked and by genre."
          items={catalog.filter((c) => c.kind === "anime")}
          onOpen={navigateTitle}
          genre={null}
          sortMode={null}
          onClearFilters={() => navigate("/anime")}
          onPickGenre={() => navigate("/anime")}
          onPickSort={() => navigate("/anime")}
        />
        )}
        {route === "/movies" && (
        <MediaTabView
          kicker="Your Libre"
          title="Movies"
          subtitle="Every movie in your catalog, ranked and by genre."
          items={catalog.filter((c) => c.kind === "movie")}
          onOpen={navigateTitle}
          genre={tabGenre}
          sortMode={tabSort}
          onClearFilters={clearTabFilters}
          onPickGenre={(g) => navigate(`/movies?genre=${encodeURIComponent(g)}`)}
          onPickSort={(mode) => navigate(`/movies?sort=${mode}`)}
        />
        )}
        {route === "/shows" && (
        <MediaTabView
          kicker="Your Libre"
          title="Shows"
          subtitle="Series and TV in your catalog, ranked and by genre."
          items={catalog.filter((c) => c.kind === "tv" || c.kind === "series")}
          onOpen={navigateTitle}
          genre={tabGenre}
          sortMode={tabSort}
          onClearFilters={clearTabFilters}
          onPickGenre={(g) => navigate(`/shows?genre=${encodeURIComponent(g)}`)}
          onPickSort={(mode) => navigate(`/shows?sort=${mode}`)}
        />
        )}
        {route === "/live" && (
          <LiveView />
        )}
        {route === "/tv" && (
        <TvView
          featured={featured}
          catalog={catalog}
          continueWatching={continueWatching}
          onWatchItem={(item) => void openWatch({ seriesId: item.id })}
          onPlayEntry={(entry) => void openWatch({
            episodeId: entry.episodeId,
            startAt: entry.position,
            onFallback: () => playAsset(entry.assetId, entry.title, entry.position, entry.episodeId),
          })}
          onShuffle={() => void shufflePlay()}
          onExit={() => navigate("/")}
        />
        )}
        {route === "/parties" && (
          partyCode ? (
            <PartyRoomView
              key={partyCode}
              code={partyCode}
              onExit={() => {
                setPartyCode(null);
                navigate("/parties");
              }}
            />
          ) : (
            <PartiesView
              user={user}
              onSignIn={() => openAuth("signin")}
              onEnter={(code) => setPartyCode(code)}
            />
          )
        )}
        {route === "/404" && (
        <div className="notfound" data-testid="notfound-view">
          <p className="hero-kicker">Lost signal</p>
          <div className="notfound-title-wrap">
            <span className="notfound-orb orb-a" aria-hidden="true" />
            <span className="notfound-orb orb-b" aria-hidden="true" />
            <h2 className="notfound-code">404</h2>
          </div>
          <p className="muted">This reel isn&apos;t in the catalog. It may have moved or never existed.</p>
          <div className="notfound-cards">
            <button type="button" className="notfound-card" onClick={() => navigate("/")}>
              <span className="notfound-card-icon" aria-hidden="true">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 9.5L12 3l9 6.5V20a1 1 0 01-1 1H5a1 1 0 01-1-1V9.5z" />
                  <path d="M9 21V12h6v9" />
                </svg>
              </span>
              <span className="notfound-card-text">
                <strong>Main Page</strong>
                <span className="muted">Back where it all begins…</span>
              </span>
              <span className="notfound-chevron" aria-hidden="true">›</span>
            </button>
            <button type="button" className="notfound-card" onClick={() => navigate("/search")}>
              <span className="notfound-card-icon" aria-hidden="true">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <circle cx="11" cy="11" r="7" />
                  <path d="m21 21-4.3-4.3" />
                </svg>
              </span>
              <span className="notfound-card-text">
                <strong>Search</strong>
                <span className="muted">Find your next watch</span>
              </span>
              <span className="notfound-chevron" aria-hidden="true">›</span>
            </button>
          </div>
        </div>
        )}

        {route === "/title" && (
          detailLoading ? (
            <p className="muted">loading title…</p>
          ) : detailError ? (
            <div>
              <button type="button" onClick={() => navigate("/")}>
                ← Back
              </button>
              <p role="alert" className="error">{detailError}</p>
            </div>
          ) : detail ? (
            <TitleDetailView
              key={selectedId ?? "title"}
              detail={detail}
              loggedIn={!!user}
              bookmarkIds={bookmarkIds}
              navLift={navLift}
              onToggleBookmark={(episodeId) => void toggleBookmark(episodeId)}
              onPlayEpisode={(episodeId) => {
                navigate(`${detail.watch_url}?ep=${encodeURIComponent(episodeId)}`);
              }}
              onWatchNow={() => {
                navigate(detail.watch_url);
              }}
              onOpenPerson={(pid) => navigatePerson(pid, `/title/${detail.id}`)}
              onOpenTitle={navigateTitle}
              onBack={() => navigate("/")}
            />
          ) : null
        )}
        {route === "/person" && (
          personLoading ? (
            <p className="muted">loading person…</p>
          ) : personError ? (
            <div>
              <button type="button" onClick={() => navigate("/")}>
                ← Back
              </button>
              <p role="alert" className="error">{personError}</p>
            </div>
          ) : person ? (
            <PersonView
              key={personId ?? "person"}
              person={person}
              onBack={() => {
                if (personReturnPath && personReturnPath.startsWith("/title/")) {
                  navigateTitle(idAfter(personReturnPath, "/title/"));
                } else if (personReturnPath) {
                  navigate(personReturnPath);
                } else navigate("/");
              }}
              onOpenTitle={navigateTitle}
              onOpenPerson={(id) => navigatePerson(id, window.location.pathname)}
              following={followedIds.includes(person.id)}
              onToggleFollow={() => toggleFollowPerson(person.id)}
            />
          ) : null
        )}

        {route === "/watch" && (() => {
          const parts = window.location.pathname.split("/").filter(Boolean);
          const kind = parts[1] ?? "";
          const extId = parts[2] ? decodeURIComponent(parts[2]) : "";
          if (!kind || !extId) {
            return (
              <div>
                <button type="button" onClick={() => navigate("/")}>
                  ← Back
                </button>
                <p role="alert" className="error">That watch link is incomplete.</p>
              </div>
            );
          }
          return (
            <WatchView
              key={`${kind}:${extId}`}
              kind={kind}
              extId={extId}
              epId={new URLSearchParams(locationSearch).get("ep")}
              onPlay={(assetId, title, startAt, episodeId, assets) =>
                playAsset(assetId, title, startAt, episodeId, assets)
              }
              activeSource={activeSource}
              srcList={srcList}
              srcIndex={srcIndex}
              onSelectSource={setSrcIndex}
              sourceLabel={sourceLabelForPlayer}
              subtitles={subTracks}
              resumeAt={resumeAt}
              onFatalError={advanceSource}
              onExit={(sid) => {
                if (sid) navigateTitle(sid);
                else navigate("/");
              }}
              onGoEpisodes={(sid) => {
                navigateTitle(sid);
                window.setTimeout(() => {
                  document.querySelector('[data-testid="episode-grid"]')?.scrollIntoView({ behavior: "smooth" });
                }, 400);
              }}
            />
          );
        })()}

        {activeSource && route !== "/parties" && route !== "/watch" && (
          <section id="player" aria-label="Player" data-testid="player-container" className="player-wrap">
            <VideoPlayer
              source={activeSource}
              startAt={resumeAt}
              subtitles={subTracks}
              onFatalError={advanceSource}
              title={trackMeta.current.get(activeSource.url)?.title ?? detail?.name ?? "Now playing"}
              year={detail?.year ?? null}
              sourceList={srcList}
              sourceIndex={srcIndex}
              onSelectSource={setSrcIndex}
              sourceLabel={sourceLabelForPlayer}
              onBack={() => {
                usePlayerStore.getState().setActiveSource(null);
                setResumeAt(undefined);
                window.scrollTo({ top: 0 });
              }}
            />
          </section>
        )}

        {route === "/" && (
        <footer className="site-footer">
          <div className="footer-grid">
            <div className="footer-brand">
              <p className="footer-logo">Libre</p>
              <p>Movies, shows, anime and watch parties in one place.</p>
              <p>Use Libre in your browser. You don&apos;t need a player download or payment details.</p>
            </div>
            <nav aria-label="Movies">
              <p className="footer-heading">Movies</p>
              <p className="footer-links">
                <button type="button" onClick={() => navigate("/movies")}>All movies</button>
                <button type="button" onClick={() => navigate("/movies?sort=popular")}>Popular</button>
                {movieFooterGenres.map((g) => (
                  <button key={g} type="button" onClick={() => navigate(`/movies?genre=${encodeURIComponent(g)}`)}>
                    {g}
                  </button>
                ))}
              </p>
            </nav>
            <nav aria-label="Shows">
              <p className="footer-heading">Shows</p>
              <p className="footer-links">
                <button type="button" onClick={() => navigate("/shows")}>All shows</button>
                <button type="button" onClick={() => navigate("/shows?sort=popular")}>Popular</button>
                <button type="button" onClick={() => navigate("/anime")}>Anime</button>
                <button type="button" onClick={() => navigate("/live")}>Live TV</button>
                {showFooterGenres.map((g) => (
                  <button key={g} type="button" onClick={() => navigate(`/shows?genre=${encodeURIComponent(g)}`)}>
                    {g}
                  </button>
                ))}
              </p>
            </nav>
          </div>
          <div className="footer-bottom">
            <span>© {new Date().getFullYear()} Libre · v0.1.0</span>
            <span>Metadata by TMDB and AniList. Not endorsed or certified by TMDB.</span>
          </div>
        </footer>
        )}
      </main>

      {authOpen && (
        <div
          className="modal-backdrop"
          data-testid="auth-modal-backdrop"
          onClick={() => setAuthOpen(false)}
        >
          <div
            className="auth-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="auth-title"
            data-testid="auth-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="modal-close"
              aria-label="Close"
              onClick={() => setAuthOpen(false)}
            >
              ✕
            </button>
            <span className="brand-mark brand-mark-lg" aria-hidden="true">L</span>
            <h2 id="auth-title">
              {authTab === "signin" ? "Welcome back" : "Create your account"}
            </h2>
            <p className="muted">
              {authTab === "signin"
                ? "Sign in to unlock your titles and keep watching."
                : "Save your session across visits with a free account."}
            </p>
            <div className="auth-tabs" role="tablist" aria-label="Account">
              <button
                type="button"
                role="tab"
                aria-selected={authTab === "signin"}
                className={authTab === "signin" ? "tab-active" : ""}
                data-testid="auth-tab-signin"
                onClick={() => setAuthTab("signin")}
              >
                Sign in
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={authTab === "register"}
                className={authTab === "register" ? "tab-active" : ""}
                data-testid="auth-tab-register"
                onClick={() => setAuthTab("register")}
              >
                Create account
              </button>
            </div>

            {authTab === "signin" ? (
              <form
                className="auth-form"
                data-testid="login-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void runLogin();
                }}
              >
                <input
                  type="email"
                  value={loginEmail}
                  onChange={(event) => setLoginEmail(event.target.value)}
                  placeholder="Email"
                  aria-label="Email"
                  autoFocus
                  data-testid="login-email"
                />
                <input
                  type="password"
                  value={loginPassword}
                  onChange={(event) => setLoginPassword(event.target.value)}
                  placeholder="Password"
                  aria-label="Password"
                  data-testid="login-password"
                />
                {loginError && (
                  <span role="alert" className="error" data-testid="login-error">
                    {loginError}
                  </span>
                )}
                <button
                  type="submit"
                  className="btn-light"
                  disabled={loginBusy}
                  data-testid="login-button"
                >
                  {loginBusy ? "Signing in…" : "Sign in"}
                </button>
              </form>
            ) : (
              <form
                className="auth-form"
                data-testid="register-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void runRegister();
                }}
              >
                <input
                  type="text"
                  value={registerName}
                  onChange={(event) => setRegisterName(event.target.value)}
                  placeholder="Display name"
                  aria-label="Display name"
                  autoFocus
                  data-testid="register-name"
                />
                <input
                  type="email"
                  value={registerEmail}
                  onChange={(event) => setRegisterEmail(event.target.value)}
                  placeholder="Email"
                  aria-label="Email"
                  data-testid="register-email"
                />
                <input
                  type="password"
                  value={registerPassword}
                  onChange={(event) => setRegisterPassword(event.target.value)}
                  placeholder="Password (8+ characters)"
                  aria-label="Password"
                  data-testid="register-password"
                />
                {registerError && (
                  <span role="alert" className="error" data-testid="register-error">
                    {registerError}
                  </span>
                )}
                <button
                  type="submit"
                  className="btn-light"
                  disabled={registerBusy}
                  data-testid="register-button"
                >
                  {registerBusy ? "Creating…" : "Create account"}
                </button>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
