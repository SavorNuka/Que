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

/** `/hls/<id>/playlist.m3u8?t=X` -> `/hls/<id>/seek/<bucket>/playlist.m3u8?t=X`. */
function seekPlaylistUrl(baseHlsUrl: string, startSeconds: number): string {
  const bucket = Math.max(0, Math.floor(startSeconds / SEEK_BUCKET_SECONDS) * SEEK_BUCKET_SECONDS);
  const url = new URL(baseHlsUrl, window.location.href);
  url.pathname = url.pathname.replace(/\/playlist\.m3u8$/, `/seek/${String(bucket)}/playlist.m3u8`);
  return url.pathname + url.search;
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
  const resumedRef = useRef(false);

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
   * A seek past what hls.js already has buffered for the current job: switch
   * to a fresh job at that offset instead of stalling on content that may
   * not exist yet. A seek within the buffered range is left to hls.js.
   */
  const onSeeking = (): void => {
    const el = ref.current;
    if (!el || !hlsBaseUrl || hlsRef.current === null) return;
    if (isBuffered(el, el.currentTime)) return;

    const targetAbsolute = hlsOffsetSeconds + el.currentTime;
    setHlsOffsetSeconds(Math.floor(targetAbsolute / SEEK_BUCKET_SECONDS) * SEEK_BUCKET_SECONDS);
    setHlsPlaylistUrl(seekPlaylistUrl(hlsBaseUrl, targetAbsolute));
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

  return (
    <div className="player" role="dialog" aria-label={`Playing ${item.title}`}>
      <div className="player-bar">
        <strong>{item.title}</strong>
        <span className="dim">
          {formatTime(hlsPlaylistUrl ? hlsOffsetSeconds + position : position)} / {formatTime(duration)}
        </span>
        <button onClick={onClose}>Close</button>
      </div>

      {error ? (
        <p className="player-error">{error}</p>
      ) : (
        <video
          ref={ref}
          src={url ?? undefined}
          controls
          autoPlay
          hidden={!playing}
          onLoadedMetadata={onLoadedMetadata}
          onTimeUpdate={() => setPosition(ref.current?.currentTime ?? 0)}
          onSeeking={onSeeking}
          onEnded={() => {
            void window.que['player:finished'](item.id);
            onClose();
          }}
          onError={() =>
            setError('The browser could not decode this file, even after remuxing/transcoding.')
          }
        />
      )}
      {!error && !playing ? <p className="dim">Opening…</p> : null}
    </div>
  );
}
