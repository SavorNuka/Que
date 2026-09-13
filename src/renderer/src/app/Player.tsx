import { useCallback, useEffect, useRef, useState } from 'react';
import type { MediaSummary } from '@shared/types';

/**
 * Playback surface.
 *
 * The element's `src` is an `http://127.0.0.1` URL from the local media server
 * rather than a custom protocol, which is what gives exact seeking
 * (ASSUMPTIONS.md A2). Files that need remuxing are catalogued but not
 * playable until M1b; the server answers those with 415 and a reason, and this
 * surfaces the reason rather than showing a dead player.
 */

interface Props {
  item: MediaSummary;
  onClose: () => void;
}

const PROGRESS_INTERVAL_MS = 5000;

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

export function Player({ item, onClose }: Props): React.JSX.Element {
  const ref = useRef<HTMLVideoElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const resumedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    resumedRef.current = false;
    setUrl(null);
    setError(null);

    window.que['media:streamUrl'](item.id)
      .then(async (streamUrl) => {
        if (cancelled) return;
        // Ask before playing: the server reports an unplayable file as 415
        // with a reason, which is more useful than a silent decode failure.
        const probe = await fetch(streamUrl, { method: 'HEAD' });
        if (cancelled) return;

        if (probe.status === 415) {
          const detail = (await fetch(streamUrl).then((r) => r.json())) as { message?: string };
          setError(detail.message ?? 'This file cannot be played yet.');
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
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });

    return () => {
      cancelled = true;
    };
  }, [item.id]);

  // Write progress back periodically and on unmount, so resume survives both
  // a normal close and a crash.
  const reportProgress = useCallback(() => {
    const el = ref.current;
    if (!el || !Number.isFinite(el.currentTime)) return;
    void window.que['player:progress'](item.id, Math.floor(el.currentTime * 1000));
  }, [item.id]);

  useEffect(() => {
    const timer = setInterval(reportProgress, PROGRESS_INTERVAL_MS);
    return () => {
      clearInterval(timer);
      reportProgress();
    };
  }, [reportProgress]);

  const onLoadedMetadata = (): void => {
    const el = ref.current;
    if (!el) return;
    setDuration(el.duration);

    // Resume once, and only once — re-applying on every metadata event would
    // fight the user's own seeking.
    if (!resumedRef.current && item.resumeMs !== null && item.resumeMs > 0) {
      resumedRef.current = true;
      el.currentTime = item.resumeMs / 1000;
    }
  };

  return (
    <div className="player" role="dialog" aria-label={`Playing ${item.title}`}>
      <div className="player-bar">
        <strong>{item.title}</strong>
        <span className="dim">
          {formatTime(position)} / {formatTime(duration)}
        </span>
        <button onClick={onClose}>Close</button>
      </div>

      {error ? (
        <p className="player-error">{error}</p>
      ) : url ? (
        <video
          ref={ref}
          src={url}
          controls
          autoPlay
          onLoadedMetadata={onLoadedMetadata}
          onTimeUpdate={() => setPosition(ref.current?.currentTime ?? 0)}
          onEnded={() => {
            void window.que['player:finished'](item.id);
            onClose();
          }}
          onError={() =>
            setError('The browser could not decode this file. It may need remuxing (M1b).')
          }
        />
      ) : (
        <p className="dim">Opening…</p>
      )}
    </div>
  );
}
