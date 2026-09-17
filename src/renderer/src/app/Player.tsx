import Hls, { type ErrorData } from 'hls.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MediaSummary } from '@shared/types';

/**
 * Playback surface.
 *
 * The element's `src` is an `http://127.0.0.1` URL from the local media server
 * rather than a custom protocol, which is what gives exact seeking
 * (ASSUMPTIONS.md A2). A file the browser can demux and decode as-is plays
 * directly; anything else (M1c) is served as progressive HLS and played with
 * hls.js — the server tells us which by answering the direct URL with 415 and
 * an `hlsUrl` to use instead, rather than the renderer guessing from codec
 * data of its own.
 */

interface Props {
  item: MediaSummary;
  onClose: () => void;
}

const PROGRESS_INTERVAL_MS = 5000;
/** Bucket size the server (`transcode/cache.ts`) also uses — the two must agree. */
const SEEK_BUCKET_SECONDS = 6;

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return '0:00';
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}

/**
 * `http://127.0.0.1:P/hls/<id>/playlist.m3u8?t=X` ->
 * `http://127.0.0.1:P/hls/<id>/seek/<bucket>/playlist.m3u8?t=X`.
 *
 * Must stay absolute. `baseHlsUrl` already is (server.ts `hlsUrlFor` — the
 * renderer's own origin is `file://` or the dev server's, never the media
 * server's), but returning only `pathname + search` here silently discards
 * that origin, and `hls.loadSource()` then resolves the relative result
 * against the *page's* origin instead — the same class of bug AAR-M1c
 * already found and fixed for the base URL, reintroduced in the seek path
 * and invisible until an actual seek is tried against a real dev server,
 * where it surfaces as hls.js's ManifestParsingError on the page's own
 * index.html rather than a clean network error.
 */
export function seekPlaylistUrl(baseHlsUrl: string, startSeconds: number): string {
  const bucket = Math.max(0, Math.floor(startSeconds / SEEK_BUCKET_SECONDS) * SEEK_BUCKET_SECONDS);
  const url = new URL(baseHlsUrl, window.location.href);
  url.pathname = url.pathname.replace(/\/playlist\.m3u8$/, `/seek/${String(bucket)}/playlist.m3u8`);
  return url.toString();
}

/** Whether `time` (seconds, media-relative) falls inside any buffered range. */
function isBuffered(el: HTMLMediaElement, time: number, toleranceSeconds = 1): boolean {
  const { buffered } = el;
  for (let i = 0; i < buffered.length; i++) {
    if (time >= buffered.start(i) - toleranceSeconds && time <= buffered.end(i) + toleranceSeconds) return true;
  }
  return false;
}

export function Player({ item, onClose }: Props): React.JSX.Element {
  const ref = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [hlsBaseUrl, setHlsBaseUrl] = useState<string | null>(null);
  const [hlsPlaylistUrl, setHlsPlaylistUrl] = useState<string | null>(null);
  const [hlsOffsetSeconds, setHlsOffsetSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const resumedRef = useRef(false);

  // The catalogue behind this modal can be taller than the viewport; a fixed
  // overlay doesn't stop the document itself from scrolling, and a native
  // scrollbar renders in the browser's own chrome layer, above this overlay's
  // z-index regardless. Suppress it for as long as the player is open.
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  /**
   * Auto-hide the control bar in fullscreen only — windowed mode keeps it
   * always visible. Two independent triggers, per spec: the mouse resting
   * near where the bar sits keeps it shown for as long as it stays there
   * (hides the instant the pointer moves away); a key press shows it and
   * starts a fresh 5-second countdown, overridden by the mouse rule while
   * the pointer is in the band.
   */
  useEffect(() => {
    if (!isFullscreen) {
      setControlsVisible(true);
      return;
    }

    const HIDE_AFTER_MS = 5000;
    const NEAR_BOTTOM_PX = 100;
    let hideTimer: ReturnType<typeof setTimeout> | null = null;
    let mouseNearBottom = false;

    const clearHideTimer = (): void => {
      if (hideTimer !== null) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
    };
    const scheduleHide = (): void => {
      clearHideTimer();
      hideTimer = setTimeout(() => {
        if (!mouseNearBottom) setControlsVisible(false);
      }, HIDE_AFTER_MS);
    };

    setControlsVisible(true);
    scheduleHide();

    const onMouseMove = (e: MouseEvent): void => {
      mouseNearBottom = e.clientY >= window.innerHeight - NEAR_BOTTOM_PX;
      if (mouseNearBottom) {
        setControlsVisible(true);
        clearHideTimer();
      } else {
        setControlsVisible(false);
      }
    };
    const onKeyDown = (): void => {
      setControlsVisible(true);
      scheduleHide();
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('keydown', onKeyDown);
      clearHideTimer();
    };
  }, [isFullscreen]);

  useEffect(() => {
    let cancelled = false;
    resumedRef.current = false;
    setUrl(null);
    setHlsBaseUrl(null);
    setHlsPlaylistUrl(null);
    setHlsOffsetSeconds(0);
    setError(null);

    window.que['media:streamUrl'](item.id)
      .then(async (streamUrl) => {
        if (cancelled) return;
        // Ask before playing: the server reports an unplayable-directly file
        // as 415 with a reason, which is more useful than a silent decode
        // failure — and, since M1c, an `hlsUrl` that actually plays it.
        const probe = await fetch(streamUrl, { method: 'HEAD' });
        if (cancelled) return;

        if (probe.status === 415) {
          const detail = (await fetch(streamUrl).then((r) => r.json())) as {
            message?: string;
            hlsUrl?: string | null;
          };
          if (cancelled) return;

          if (detail.hlsUrl) {
            setHlsBaseUrl(detail.hlsUrl);
            // Resuming far into a large file: ask for that offset directly
            // rather than waiting for the from-start job to grow all the way
            // there, which could be slow for a genuine video transcode
            // (PRA-M1c §5.3).
            const resumeSeconds = item.resumeMs !== null && item.resumeMs > 0 ? item.resumeMs / 1000 : 0;
            if (resumeSeconds > SEEK_BUCKET_SECONDS) {
              setHlsOffsetSeconds(
                Math.floor(resumeSeconds / SEEK_BUCKET_SECONDS) * SEEK_BUCKET_SECONDS
              );
              setHlsPlaylistUrl(seekPlaylistUrl(detail.hlsUrl, resumeSeconds));
            } else {
              setHlsPlaylistUrl(detail.hlsUrl);
            }
          } else {
            setError(detail.message ?? 'This file cannot be played yet.');
          }
          return;
        }
        if (probe.status === 410) {
          setError('The file is no longer where Que last saw it. Rescan the library.');
          return;
        }
        if (!probe.ok) {
          setError(`The media server refused this file (HTTP ${probe.status}).`);
          return;
        }
        setUrl(streamUrl);
        setDuration((item.durationMs ?? 0) / 1000);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- item.resumeMs/durationMs only matter at open time
  }, [item.id]);

  /**
   * hls.js wiring. Re-runs whenever `hlsPlaylistUrl` changes — including a
   * mid-playback seek beyond the buffered range, which points it at a new
   * job's playlist entirely rather than trying to splice one running
   * manifest (a deliberate simplification of PRA-M1c §5.3, still exact —
   * every seek still lands on a real segment boundary, just via a fresh
   * manifest instead of a discontinuity tag).
   */
  useEffect(() => {
    const el = ref.current;
    if (!hlsPlaylistUrl || !el) return;

    if (!Hls.isSupported()) {
      setError('This browser cannot play transcoded media (no MediaSource support).');
      return;
    }

    const token = new URL(hlsPlaylistUrl, window.location.href).searchParams.get('t');
    const hls = new Hls({
      // The very first playlist fetch commonly 503s for a moment while
      // ffmpeg writes it — under a second for a plain remux (PRA-M1c §3
      // M-1). Retry quickly rather than surfacing a fatal error for a
      // normal startup delay.
      manifestLoadingMaxRetry: 8,
      manifestLoadingRetryDelay: 500,
      xhrSetup: (xhr) => {
        // ffmpeg's own playlist has no idea about our auth token, and a bare
        // relative segment reference drops the base URL's query string on
        // resolution — the header form of the same check (server.ts
        // `authorised()`) carries it on every request instead.
        if (token) xhr.setRequestHeader('x-que-token', token);
      },
    });
    hlsRef.current = hls;

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      setDuration((item.durationMs ?? 0) / 1000);
      if (!resumedRef.current) {
        resumedRef.current = true;
        const withinThisJob = item.resumeMs !== null ? item.resumeMs / 1000 - hlsOffsetSeconds : 0;
        if (withinThisJob > 0) el.currentTime = withinThisJob;
      }
      void el.play().catch(() => undefined);
    });

    hls.on(Hls.Events.ERROR, (_event, data: ErrorData) => {
      if (!data.fatal) return;
      setError(`Playback error: ${data.details}`);
      hls.destroy();
    });

    hls.loadSource(hlsPlaylistUrl);
    hls.attachMedia(el);

    return () => {
      hls.destroy();
      hlsRef.current = null;
    };
  }, [hlsPlaylistUrl, hlsOffsetSeconds, item.resumeMs, item.durationMs]);

  /**
   * The scrub bar always spans the real file duration (`item.durationMs`,
   * known from the probe at scan time, independent of how much a progressive
   * HLS job has generated so far) — unlike the *native* `<video>` control,
   * which reads `el.duration`/`el.currentTime` off whatever job is currently
   * loaded and so can only represent that job's own small, local timeline.
   * That mismatch is what made the native scrub bar show the wrong total and
   * cap seeking to a few minutes around the last seek point.
   *
   * A target already inside the current job's buffered range is a plain
   * `currentTime` set (hls.js serves it from what's already downloaded); one
   * outside it starts a fresh job at that offset, same mechanism as before.
   */
  const seekTo = (targetSeconds: number): void => {
    const el = ref.current;
    if (!el) return;

    if (!hlsPlaylistUrl) {
      el.currentTime = targetSeconds;
      return;
    }
    if (!hlsBaseUrl) return;

    const relative = targetSeconds - hlsOffsetSeconds;
    if (relative >= 0 && isBuffered(el, relative)) {
      el.currentTime = relative;
      return;
    }

    setHlsOffsetSeconds(Math.max(0, Math.floor(targetSeconds / SEEK_BUCKET_SECONDS) * SEEK_BUCKET_SECONDS));
    setHlsPlaylistUrl(seekPlaylistUrl(hlsBaseUrl, targetSeconds));
  };

  /**
   * Fullscreen goes through the main process (`player:setFullscreen` ->
   * `BrowserWindow.setFullScreen()`), not the HTML5 Fullscreen API. A generic
   * `Element.requestFullscreen()` call from this renderer never once
   * resolved or rejected in manual testing — no error, no `fullscreenchange`
   * event, no visible effect, just a permanently pending promise. The native
   * window method worked immediately. Subscribing to the pushed event
   * (rather than only setting state optimistically) keeps this correct if a
   * keyboard shortcut or the OS's own window chrome changes it instead.
   */
  useEffect(() => window.que.on('player:fullscreenChanged', ({ fullscreen }) => setIsFullscreen(fullscreen)), []);

  const toggleFullscreen = (): void => {
    void window.que['player:setFullscreen'](!isFullscreen);
  };

  const togglePlay = (): void => {
    const el = ref.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => undefined);
    else el.pause();
  };

  const toggleMuted = (): void => {
    const el = ref.current;
    const next = !muted;
    setMuted(next);
    if (el) el.muted = next;
  };

  const onVolumeChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const next = Number(e.target.value);
    setVolume(next);
    const el = ref.current;
    if (el) el.volume = next;
    if (next > 0 && muted) toggleMuted();
  };

  // Write progress back periodically and on unmount, so resume survives both
  // a normal close and a crash. Position is always absolute — the HLS path's
  // own media clock restarts at 0 for every job, so the offset is added back.
  const reportProgress = useCallback(() => {
    const el = ref.current;
    if (!el || !Number.isFinite(el.currentTime)) return;
    const absoluteMs = Math.floor((hlsOffsetSeconds + el.currentTime) * 1000);
    void window.que['player:progress'](item.id, absoluteMs);
  }, [item.id, hlsOffsetSeconds]);

  useEffect(() => {
    const timer = setInterval(reportProgress, PROGRESS_INTERVAL_MS);
    return () => {
      clearInterval(timer);
      reportProgress();
    };
  }, [reportProgress]);

  const onLoadedMetadata = (): void => {
    const el = ref.current;
    if (!el || hlsPlaylistUrl) return; // HLS path sets duration/resume itself, from MediaDetail
    setDuration(el.duration);

    // Resume once, and only once — re-applying on every metadata event would
    // fight the user's own seeking.
    if (!resumedRef.current && item.resumeMs !== null && item.resumeMs > 0) {
      resumedRef.current = true;
      el.currentTime = item.resumeMs / 1000;
    }
  };

  const playing = url ?? hlsPlaylistUrl;
  const absolutePosition = hlsPlaylistUrl ? hlsOffsetSeconds + position : position;

  return (
    <div className="player" role="dialog" aria-label={`Playing ${item.title}`}>
      {/* Hidden in fullscreen: real OS-window fullscreen (player:setFullscreen)
          isn't the HTML5 Fullscreen API, so nothing hides this automatically
          the way a fullscreened element's non-fullscreen siblings would be. */}
      {!isFullscreen && (
        <div className="player-bar">
          <strong>{item.title}</strong>
          <button onClick={onClose}>Close</button>
        </div>
      )}

      {error ? (
        <p className="player-error">{error}</p>
      ) : (
        <div className={`player-media${isFullscreen ? ' fullscreen' : ''}`}>
          <video
            ref={ref}
            src={url ?? undefined}
            autoPlay
            hidden={!playing}
            onLoadedMetadata={onLoadedMetadata}
            onTimeUpdate={() => setPosition(ref.current?.currentTime ?? 0)}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            onEnded={() => {
              void window.que['player:finished'](item.id);
              onClose();
            }}
            onError={() =>
              setError('The browser could not decode this file, even after remuxing/transcoding.')
            }
          />
          {playing && (
            <div className={`player-controls${controlsVisible ? '' : ' hidden'}`}>
              <button type="button" onClick={togglePlay}>
                {isPlaying ? 'Pause' : 'Play'}
              </button>
              <span className="time">{formatTime(absolutePosition)}</span>
              <input
                type="range"
                className="scrub"
                aria-label="Seek"
                min={0}
                max={Math.max(duration, 1)}
                step={1}
                value={Math.min(absolutePosition, Math.max(duration, 1))}
                onChange={(e) => seekTo(Number(e.target.value))}
              />
              <span className="time">{formatTime(duration)}</span>
              <button type="button" onClick={toggleMuted}>
                {muted ? 'Unmute' : 'Mute'}
              </button>
              <input
                type="range"
                className="volume"
                aria-label="Volume"
                min={0}
                max={1}
                step={0.05}
                value={muted ? 0 : volume}
                onChange={onVolumeChange}
              />
              <button type="button" onClick={toggleFullscreen}>
                {isFullscreen ? 'Exit full screen' : 'Full screen'}
              </button>
            </div>
          )}
        </div>
      )}
      {!error && !playing ? <p className="dim">Opening…</p> : null}
    </div>
  );
}
