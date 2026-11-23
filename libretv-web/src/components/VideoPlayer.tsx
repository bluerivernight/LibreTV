// Libre — video player with dulo-style chrome.
// HLS is played through hls.js when supported (all modern browsers); Safari/iOS
// fall back to the native `application/vnd.apple.mpegurl` path. MP4 falls straight
// through to the <video> element. Playback and seek are exposed through a ref.
//
// Chrome: top bar (back, title + year, brand), seekable progress, transport
// controls (play, ∓10s, volume, time), and a settings panel (sources, quality,
// audio, subtitles, speed, volume boost, picture size) plus PiP/fullscreen.
// Every control performs its labeled action; rows without backing data are
// hidden (no fake providers, no fake skip markers).

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import Hls from "hls.js";
import type { ErrorData, Events } from "hls.js";

import { usePlayerStore } from "../stores/playerStore";
import type { PlayerSource } from "../stores/playerStore";
import "./VideoPlayer.css";

export interface VideoPlayerHandle {
  play: () => void;
  pause: () => void;
  seekTo: (seconds: number) => void;
}

interface VideoPlayerProps {
  source: PlayerSource;
  className?: string;
  /** Resume position in seconds (Continue Watching). Applied once per source. */
  startAt?: number;
  /** Subtitle tracks (WebVTT URLs). First track shows by default. */
  subtitles?: Array<{ id: string; language: string; url: string }>;
  /** Called once per source when playback fails fatally (auto-failover hook). */
  onFatalError?: () => void;
  /** Fired on the first playing event per source (hides theater loaders). */
  onFirstFrame?: () => void;
  /** Title shown in the top bar. */
  title?: string;
  year?: number | null;
  /** Episode line under the title, e.g. "S1 · E1 — Episode 1". */
  episodeLabel?: string | null;
  /** Top-right previous-episode action. Hidden when absent. */
  onPrevEpisode?: () => void;
  /** Top-left back action (stop + return). Hidden when absent. */
  onBack?: () => void;
  /** Rendition/source switching (dulo "Sources" view). Hidden when empty. */
  sourceList?: string[];
  sourceIndex?: number;
  onSelectSource?: (index: number) => void;
  sourceLabel?: (id: string, index: number) => string;
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

function fmtTime(total: number): string {
  if (!Number.isFinite(total) || total < 0) total = 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

type Panel = null | "settings" | "sources" | "quality" | "audio" | "subs" | "speed";

const VideoPlayer = forwardRef<VideoPlayerHandle, VideoPlayerProps>(function VideoPlayer(
  {
    source, className, startAt, subtitles, onFatalError, onFirstFrame,
    title, episodeLabel, onPrevEpisode, onBack, sourceList, sourceIndex, onSelectSource, sourceLabel,
  },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const soughtFor = useRef<string | null>(null);
  const failedFor = useRef<string | null>(null);
  const framedFor = useRef<string | null>(null);
  const autoplayFor = useRef<string | null>(null);
  const idleTimer = useRef<number | undefined>(undefined);
  const audioCtx = useRef<AudioContext | null>(null);
  const gainNode = useRef<GainNode | null>(null);
  const mediaSrc = useRef<MediaElementAudioSourceNode | null>(null);
  const { setActiveSource, setIsPlaying, setCurrentTime, setDuration } = usePlayerStore();

  const [isPlaying, setPlayingUi] = useState(false);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [boost, setBoost] = useState(false);
  const [fit, setFit] = useState<"fill" | "fit">("fit");
  const [subIndex, setSubIndex] = useState<number | null>(0);
  const [panel, setPanel] = useState<Panel>(null);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [idle, setIdle] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [pipSupported] = useState(
    () => typeof document !== "undefined" && "pictureInPictureEnabled" in document && document.pictureInPictureEnabled,
  );

  const tracks = subtitles ?? [];
  const hasSources = !!sourceList && sourceList.length > 0;
  const activeSourceIndex = sourceIndex ?? 0;
  const labelOf = useCallback(
    (id: string, i: number) => (sourceLabel ? sourceLabel(id, i) : `Source ${i + 1}`),
    [sourceLabel],
  );

  useImperativeHandle(ref, () => ({
    play: () => {
      void videoRef.current?.play();
    },
    pause: () => {
      videoRef.current?.pause();
    },
    seekTo: (seconds: number) => {
      if (videoRef.current) videoRef.current.currentTime = seconds;
    },
  }));

  // Load the source: mp4 (src) vs HLS (hls.js or native).
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    setActiveSource(source);

    const playNative = (url: string) => {
      video.src = url;
      return () => {
        video.removeAttribute("src");
        video.load();
      };
    };

    if (source.type === "mp4") return playNative(source.url);

    // Prefer hls.js whenever MSE exists: uniform behavior across browsers.
    // Native playback is only for platforms without MSE (e.g. iOS Safari).
    if (Hls.isSupported()) {
      const hls = new Hls({
        // Session cookie covers playlist + segment requests (ARCHITECTURE.md §7 auth).
        xhrSetup: (xhr) => {
          xhr.withCredentials = true;
        },
      });
      hls.loadSource(source.url);
      hls.attachMedia(video);

      const failOver = () => {
        // Unrecoverable for this source: hand off so the app can fail over to
        // the next source. Guarded per-source URL (no repeated firing).
        hls.destroy();
        if (failedFor.current !== source.url) {
          failedFor.current = source.url;
          onFatalError?.();
        }
      };
      const handleError = (_event: Events, data: ErrorData) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          // Missing manifest/playlist or level → fail over; fragments retry.
          if (
            data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR ||
            data.details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT ||
            data.details === Hls.ErrorDetails.LEVEL_LOAD_ERROR ||
            data.details === Hls.ErrorDetails.LEVEL_LOAD_TIMEOUT
          ) {
            failOver();
          } else {
            hls.startLoad();
          }
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hls.recoverMediaError();
        } else {
          failOver();
        }
      };
      hls.on(Hls.Events.ERROR, handleError);

      return () => {
        hls.destroy();
      };
    }

    return playNative(source.url);
  }, [source, setActiveSource]);

  // Keep the subtitle track modes in sync with the menu selection.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const list = video.textTracks;
    for (let i = 0; i < list.length; i++) {
      list[i]!.mode = subIndex === i ? "showing" : "disabled";
    }
  }, [subIndex, source.url, tracks.length]);

  // Reset per-source UI (subtitle defaults to the first track).
  useEffect(() => {
    setSubIndex(tracks.length > 0 ? 0 : null);
    setPanel(null);
  }, [source.url, tracks.length]);
  // Sync playback events into local UI + the shared store.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onPlay = () => {
      setIsPlaying(true);
      setPlayingUi(true);
      if (framedFor.current !== source.url) {
        framedFor.current = source.url;
        onFirstFrame?.();
      }
    };
    const onPause = () => {
      setIsPlaying(false);
      setPlayingUi(false);
    };
    const onTimeUpdate = () => {
      setCurrentTime(video.currentTime);
      setTime(video.currentTime);
    };
    const onProgress = () => {
      try {
        const b = video.buffered;
        if (b.length > 0 && video.duration > 0) {
          setBuffered(Math.min(1, b.end(b.length - 1) / video.duration));
        }
      } catch {
        // Buffered ranges can throw mid-seek; the bar simply stays put.
      }
    };
    const onLoadedMetadata = () => {
      setDuration(video.duration);
      setDur(video.duration);
      setRate(video.playbackRate);
      setVolume(video.volume);
      setMuted(video.muted);
      // Continue Watching resume: seek once per loaded source.
      if (
        startAt !== undefined &&
        Number.isFinite(startAt) &&
        startAt > 0 &&
        soughtFor.current !== source.url &&
        Number.isFinite(video.duration) &&
        startAt < video.duration
      ) {
        soughtFor.current = source.url;
        video.currentTime = startAt;
      }
    };
    const onDurationChange = () => {
      setDuration(video.duration);
      setDur(video.duration);
    };
    const onCanPlay = () => {
      // Theater autoplay: browsers may block unmuted starts; the on-screen
      // play button covers the rejection path.
      if (autoplayFor.current !== source.url) {
        autoplayFor.current = source.url;
        void video.play().catch(() => {
          // Blocked — user starts with the center play button.
        });
      }
    };
    const onVolumeChange = () => {
      setVolume(video.volume);
      setMuted(video.muted);
    };
    const onRateChange = () => setRate(video.playbackRate);

    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("progress", onProgress);
    video.addEventListener("loadedmetadata", onLoadedMetadata);
    video.addEventListener("durationchange", onDurationChange);
    video.addEventListener("volumechange", onVolumeChange);
    video.addEventListener("ratechange", onRateChange);
    video.addEventListener("canplay", onCanPlay);

    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("progress", onProgress);
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
      video.removeEventListener("durationchange", onDurationChange);
      video.removeEventListener("volumechange", onVolumeChange);
      video.removeEventListener("ratechange", onRateChange);
      video.removeEventListener("canplay", onCanPlay);
    };
  }, [setIsPlaying, setCurrentTime, setDuration, source.url, startAt]);

  // Fullscreen state follows the document (covers Esc exits too).
  useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  // Auto-hide chrome while playing (never hides when paused or panel-open).
  const poke = useCallback(() => {
    setIdle(false);
    window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => {
      const playing = videoRef.current ? !videoRef.current.paused : false;
      setPanel((p) => {
        if (!playing || p !== null) {
          setIdle(false);
          return p;
        }
        setIdle(true);
        return p;
      });
    }, 3000);
  }, []);
  useEffect(() => () => window.clearTimeout(idleTimer.current), []);
  useEffect(() => {
    // Waking state follows pause/panel so controls return immediately.
    if (!videoRef.current?.paused && panel === null) poke();
    else {
      window.clearTimeout(idleTimer.current);
      setIdle(false);
    }
  }, [isPlaying, panel, poke]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play();
    else video.pause();
    poke();
  }, [poke]);

  const seekBy = useCallback((delta: number) => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration)) return;
    video.currentTime = Math.min(Math.max(0, video.currentTime + delta), video.duration || 0);
    poke();
  }, [poke]);

  const seekToFraction = useCallback((fraction: number) => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration)) return;
    video.currentTime = Math.min(Math.max(0, fraction), 1) * video.duration;
    poke();
  }, [poke]);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    poke();
  }, [poke]);

  const changeVolume = useCallback((value: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = Math.min(Math.max(0, value), 1);
    if (value > 0) video.muted = false;
  }, []);

  const pickRate = useCallback((value: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.playbackRate = value;
    setPanel("settings");
  }, []);

  const toggleBoost = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    try {
      const Ctor = window.AudioContext;
      if (!Ctor) return;
      if (!audioCtx.current) audioCtx.current = new Ctor();
      const ctx = audioCtx.current;
      void ctx.resume();
      if (!mediaSrc.current) {
        mediaSrc.current = ctx.createMediaElementSource(video);
        gainNode.current = ctx.createGain();
        mediaSrc.current.connect(gainNode.current);
        gainNode.current.connect(ctx.destination);
      }
      const next = !boost;
      if (gainNode.current) gainNode.current.gain.value = next ? 1.6 : 1;
      setBoost(next);
    } catch {
      // Media without CORS approval can't enter the graph: boost stays off.
    }
    poke();
  }, [boost, poke]);

  const toggleFit = useCallback(() => {
    setFit((f) => (f === "fit" ? "fill" : "fit"));
    poke();
  }, [poke]);

  const toggleFullscreen = useCallback(() => {
    const box = boxRef.current;
    if (!box) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void box.requestFullscreen().catch(() => {
      // Fullscreen blocked (e.g. iframe permissions): stay inline.
    });
    poke();
  }, [poke]);

  const togglePip = useCallback(async () => {
    const video = videoRef.current as HTMLVideoElement & {
      webkitSetPresentationMode?: (mode: string) => void;
    };
    if (!video) return;
    try {
      const doc = document as Document & {
        pictureInPictureElement?: Element | null;
        exitPictureInPicture?: () => Promise<void>;
      };
      if (doc.pictureInPictureElement && doc.exitPictureInPicture) {
        await doc.exitPictureInPicture();
      } else if (video.disablePictureInPicture !== true && video.requestPictureInPicture) {
        await video.requestPictureInPicture();
      } else if (video.webkitSetPresentationMode) {
        video.webkitSetPresentationMode("picture-in-picture");
      }
    } catch {
      // PiP rejected (e.g. no video data yet): stay inline.
    }
    poke();
  }, [poke]);

  const onKeys = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      if (showShortcuts) {
        setShowShortcuts(false);
        return;
      }
      if (panel !== null) {
        setPanel(null);
        return;
      }
    }
    if ((e.target as HTMLElement)?.tagName === "SELECT") return;
    switch (e.key) {
      case " ":
      case "k":
        e.preventDefault();
        togglePlay();
        break;
      case "ArrowLeft":
        e.preventDefault();
        seekBy(-10);
        break;
      case "ArrowRight":
        e.preventDefault();
        seekBy(10);
        break;
      case "ArrowUp":
        e.preventDefault();
        changeVolume(volume + 0.1);
        break;
      case "ArrowDown":
        e.preventDefault();
        changeVolume(volume - 0.1);
        break;
      case "m":
        toggleMute();
        break;
      case "f":
        toggleFullscreen();
        break;
      case "?":
        e.preventDefault();
        setShowShortcuts((visible) => !visible);
        break;
      default:
        break;
    }
  };

  const played = dur > 0 ? Math.min(1, time / dur) : 0;
  const currentLabel = hasSources ? labelOf(sourceList[activeSourceIndex] ?? "", activeSourceIndex) : null;
  const subLabel = subIndex === null ? "Off" : (tracks[subIndex]?.language ?? "Off");
  const rateLabel = rate === 1 ? "Normal" : `${rate}×`;
  const chromeHidden = idle && panel === null && !showShortcuts;

  const closePanel = () => setPanel(null);

  return (
    <div
      ref={boxRef}
      className={`vp${chromeHidden ? " vp-idle" : ""}${isFullscreen ? " vp-full" : ""}`}
      data-testid="video-chrome"
      onPointerMove={poke}
      onPointerDown={poke}
      onKeyDown={onKeys}
      tabIndex={0}
      role="region"
      aria-label={title ?? "Video player"}
    >
      <video
        ref={videoRef}
        className={`vp-video${fit === "fill" ? " vp-fill" : ""} ${className ?? ""}`}
        playsInline
        preload="auto"
        crossOrigin="use-credentials"
        data-testid="video-player"
        onClick={togglePlay}
      >
        {tracks.map((track, i) => (
          <track
            key={track.id}
            kind="subtitles"
            src={track.url}
            srcLang={track.language}
            label={track.language}
            {...(i === 0 ? { default: true } : {})}
          />
        ))}
      </video>

      {/* Center play while paused (autoplay-blocked starts, manual pauses). */}
      {!isPlaying && (
        <button
          type="button"
          className="vp-bigplay"
          onClick={togglePlay}
          aria-label="Play"
        >
          ▶
        </button>
      )}

      {/* Top bar — title on the left, transport + brand on the right. */}
      <div className="vp-top vp-chrome">
        {onBack && (
          <button type="button" className="vp-back" onClick={onBack} aria-label="Back">
            ←
          </button>
        )}
        <div className="vp-titles">
          <span className="vp-title">{title ?? "Now playing"}</span>
          {episodeLabel && <span className="vp-episode">{episodeLabel}</span>}
        </div>
        <span className="vp-spacer" />
        <div className="vp-top-actions">
          {onPrevEpisode && (
            <button type="button" className="vp-btn" onClick={onPrevEpisode} aria-label="Previous episode">
              ⏮
            </button>
          )}
          <button type="button" className="vp-btn" onClick={togglePlay} aria-label={isPlaying ? "Pause" : "Play"}>
            {isPlaying ? "❚❚" : "▶"}
          </button>
          <button
            type="button"
            className="vp-btn"
            onClick={() => setPanel(panel === "subs" ? null : "subs")}
            aria-label="Subtitles"
            aria-expanded={panel === "subs"}
          >
            ▤
          </button>
          <span className="vp-brand" aria-hidden="true">
            Libre<span className="vp-brand-dot">.</span>
          </span>
        </div>
      </div>

      {/* Settings / sources panel */}
      {panel !== null && (
        <div className="vp-panel" role="dialog" aria-label="Player settings">
          {panel === "settings" && (
            <>
              <div className="vp-panel-head">
                <span className="muted">
                  {hasSources ? `Source ${activeSourceIndex + 1} / ${sourceList.length}` : "Settings"}
                </span>
                <button type="button" className="vp-x" onClick={closePanel} aria-label="Close settings">
                  ✕
                </button>
              </div>
              {hasSources && (
                <button type="button" className="vp-source-card" onClick={() => setPanel("sources")}>
                  <span className="vp-source-icon" aria-hidden="true">
                    {(currentLabel ?? "?").charAt(0).toUpperCase()}
                  </span>
                  <span className="vp-source-name">{currentLabel}</span>
                  <span className="muted">In use</span>
                  <span className="vp-source-meta">
                    <span>
                      <span className="muted">Quality</span>
                      <strong>{currentLabel}</strong>
                    </span>
                  </span>
                </button>
              )}
              <div className="vp-rows">
                {hasSources && (
                  <button type="button" className="vp-row" onClick={() => setPanel("quality")}>
                    <span className="muted">Quality</span>
                    <strong>{currentLabel}</strong>
                  </button>
                )}
                <button type="button" className="vp-row" onClick={() => setPanel("audio")}>
                  <span className="muted">Audio</span>
                  <strong>Default</strong>
                </button>
                {tracks.length > 0 && (
                  <button type="button" className="vp-row" onClick={() => setPanel("subs")}>
                    <span className="muted">Subtitles</span>
                    <strong>{subLabel}</strong>
                  </button>
                )}
                <button type="button" className="vp-row" onClick={() => setPanel("speed")}>
                  <span className="muted">Playback speed</span>
                  <strong>{rateLabel}</strong>
                </button>
                <button type="button" className="vp-row" onClick={toggleBoost}>
                  <span className="muted">Volume boost</span>
                  <strong>{boost ? "On" : "Off"}</strong>
                </button>
              </div>
              <button type="button" className="vp-row vp-wide" onClick={toggleFit}>
                <span className="muted">Picture size</span>
                <strong>{fit === "fill" ? "Fill screen" : "Fit"}</strong>
              </button>
            </>
          )}

          {panel === "sources" && hasSources && (
            <>
              <div className="vp-panel-head">
                <button type="button" className="vp-backlink" onClick={() => setPanel("settings")}>
                  Back
                </button>
                <strong>Sources</strong>
                <button type="button" className="vp-x" onClick={closePanel} aria-label="Close sources">
                  ✕
                </button>
              </div>
              <p className="muted vp-count">{sourceList.length} sources</p>
              <ul className="vp-sources">
                {sourceList.map((id, i) => {
                  const active = i === activeSourceIndex;
                  return (
                    <li key={id}>
                      <button
                        type="button"
                        className={`vp-source${active ? " vp-source-active" : ""}`}
                        disabled={active}
                        onClick={() => {
                          onSelectSource?.(i);
                          closePanel();
                        }}
                      >
                        <span className="vp-source-icon" aria-hidden="true">
                          {labelOf(id, i).charAt(0).toUpperCase()}
                        </span>
                        <span className="vp-source-name">
                          {labelOf(id, i)}
                          <span className="muted">{active ? "In use" : "Not checked"}</span>
                        </span>
                        {active && <span aria-hidden="true">✓</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}

          {panel === "quality" && hasSources && (
            <>
              <div className="vp-panel-head">
                <button type="button" className="vp-backlink" onClick={() => setPanel("settings")}>
                  Back
                </button>
                <strong>Quality</strong>
                <button type="button" className="vp-x" onClick={closePanel} aria-label="Close quality">
                  ✕
                </button>
              </div>
              <ul className="vp-options">
                {sourceList.map((id, i) => (
                  <li key={id}>
                    <button
                      type="button"
                      className="vp-option"
                      disabled={i === activeSourceIndex}
                      onClick={() => {
                        onSelectSource?.(i);
                        closePanel();
                      }}
                    >
                      <span>{labelOf(id, i)}</span>
                      {i === activeSourceIndex && <span aria-hidden="true">✓</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}

          {panel === "audio" && (
            <>
              <div className="vp-panel-head">
                <button type="button" className="vp-backlink" onClick={() => setPanel("settings")}>
                  Back
                </button>
                <strong>Audio</strong>
                <button type="button" className="vp-x" onClick={closePanel} aria-label="Close audio">
                  ✕
                </button>
              </div>
              <ul className="vp-options">
                <li>
                  <button type="button" className="vp-option" disabled>
                    <span>Default</span>
                    <span aria-hidden="true">✓</span>
                  </button>
                </li>
              </ul>
            </>
          )}

          {panel === "subs" && tracks.length > 0 && (
            <>
              <div className="vp-panel-head">
                <button type="button" className="vp-backlink" onClick={() => setPanel("settings")}>
                  Back
                </button>
                <strong>Subtitles</strong>
                <button type="button" className="vp-x" onClick={closePanel} aria-label="Close subtitles">
                  ✕
                </button>
              </div>
              <ul className="vp-options">
                <li>
                  <button
                    type="button"
                    className="vp-option"
                    disabled={subIndex === null}
                    onClick={() => {
                      setSubIndex(null);
                      setPanel("settings");
                    }}
                  >
                    <span>Off</span>
                    {subIndex === null && <span aria-hidden="true">✓</span>}
                  </button>
                </li>
                {tracks.map((t, i) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      className="vp-option"
                      disabled={subIndex === i}
                      onClick={() => {
                        setSubIndex(i);
                        setPanel("settings");
                      }}
                    >
                      <span>{t.language}</span>
                      {subIndex === i && <span aria-hidden="true">✓</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}

          {panel === "speed" && (
            <>
              <div className="vp-panel-head">
                <button type="button" className="vp-backlink" onClick={() => setPanel("settings")}>
                  Back
                </button>
                <strong>Playback speed</strong>
                <button type="button" className="vp-x" onClick={closePanel} aria-label="Close speed">
                  ✕
                </button>
              </div>
              <ul className="vp-options">
                {SPEEDS.map((s) => (
                  <li key={s}>
                    <button
                      type="button"
                      className="vp-option"
                      disabled={rate === s}
                      onClick={() => pickRate(s)}
                    >
                      <span>{s === 1 ? "Normal" : `${s}×`}</span>
                      {rate === s && <span aria-hidden="true">✓</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {showShortcuts && (
        <div className="vp-shortcuts" role="dialog" aria-label="Keyboard shortcuts" data-testid="shortcuts-overlay">
          <div className="vp-shortcuts-head">
            <strong>Keyboard shortcuts</strong>
            <button type="button" onClick={() => setShowShortcuts(false)} aria-label="Close shortcuts">
              ✕
            </button>
          </div>
          <ul>
            <li><kbd>Space</kbd> / <kbd>K</kbd><span>Play or pause</span></li>
            <li><kbd>←</kbd> / <kbd>→</kbd><span>Back / forward 10 seconds</span></li>
            <li><kbd>↑</kbd> / <kbd>↓</kbd><span>Volume up / down</span></li>
            <li><kbd>M</kbd><span>Mute or unmute</span></li>
            <li><kbd>F</kbd><span>Fullscreen</span></li>
            <li><kbd>?</kbd><span>Toggle this help</span></li>
            <li><kbd>Esc</kbd><span>Close panels</span></li>
          </ul>
        </div>
      )}

      {/* Bottom chrome — dulo-style transport row. */}
      <div className="vp-bottom vp-chrome">
        <div
          className="vp-progress"
          role="slider"
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(dur)}
          aria-valuenow={Math.round(time)}
          tabIndex={0}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            if (rect.width > 0) seekToFraction((e.clientX - rect.left) / rect.width);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") {
              e.preventDefault();
              seekBy(-10);
            } else if (e.key === "ArrowRight") {
              e.preventDefault();
              seekBy(10);
            }
          }}
        >
          <span className="vp-buffered" style={{ width: `${Math.round(buffered * 100)}%` }} aria-hidden="true" />
          <span className="vp-played" style={{ width: `${Math.round(played * 100)}%` }} aria-hidden="true" />
          <span className="vp-knob" style={{ left: `${Math.round(played * 100)}%` }} aria-hidden="true" />
        </div>
        <div className="vp-controls">
          <button type="button" className="vp-btn vp-btn-primary" onClick={togglePlay} aria-label={isPlaying ? "Pause" : "Play"}>
            {isPlaying ? "❚❚" : "▶"}
          </button>
          <button type="button" className="vp-btn" onClick={() => seekBy(-10)} aria-label="Back 10 seconds">
            ↺
          </button>
          <button type="button" className="vp-btn" onClick={() => seekBy(10)} aria-label="Forward 10 seconds">
            ↻
          </button>
          <button type="button" className="vp-btn" onClick={toggleMute} aria-label={muted || volume === 0 ? "Unmute" : "Mute"}>
            {muted || volume === 0 ? "🔇" : volume < 0.5 ? "🔈" : "🔊"}
          </button>
          <input
            type="range"
            className="vp-volume"
            aria-label="Volume"
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            onChange={(e) => changeVolume(Number(e.target.value))}
          />
          <span className="vp-time">
            {fmtTime(time)} / {fmtTime(dur)}
          </span>
          <span className="vp-spacer" />
          <button
            type="button"
            className="vp-btn vp-tool"
            onClick={() => setPanel(panel === "speed" ? null : "speed")}
            aria-label="Playback speed"
            aria-expanded={panel === "speed"}
          >
            ☷
          </button>
          <button
            type="button"
            className="vp-btn vp-tool"
            onClick={() => setPanel(panel === "subs" ? null : "subs")}
            aria-label="Subtitles"
            aria-expanded={panel === "subs"}
          >
            ▤
          </button>
          <button
            type="button"
            className="vp-btn vp-tool"
            onClick={() => setPanel(panel === "settings" ? null : "settings")}
            aria-label="Settings"
            aria-expanded={panel === "settings" || panel === "sources"}
          >
            ⚙
          </button>
          {pipSupported && (
            <button type="button" className="vp-btn vp-tool" onClick={() => void togglePip()} aria-label="Picture in picture">
              ⧉
            </button>
          )}
          <button
            type="button"
            className="vp-btn vp-tool"
            onClick={toggleFullscreen}
            aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
          >
            {isFullscreen ? "⤢" : "⛶"}
          </button>
        </div>
      </div>

    </div>
  );
});

export default VideoPlayer;
