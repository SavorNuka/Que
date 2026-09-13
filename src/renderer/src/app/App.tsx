import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AppInfo,
  MediaKind,
  MediaSummary,
  ProviderStatus,
  ScanResult,
  Source,
} from '@shared/types';
import { Player } from './Player';

/**
 * M0 shell.
 *
 * Deliberately plain: it exists to prove the bridge end to end — source paths,
 * drag-and-drop and dialog import, catalogue read, search, provider status.
 * The real library UI arrives in M1/M2.
 */

const DEFAULT_SORT = { key: 'title', dir: 'asc' } as const;
const DEFAULT_FILTER = { match: 'all' } as const;

/**
 * Run an async function once per dependency change.
 *
 * The dependency array is SPREAD, and `fn` is held in a ref rather than
 * depended upon. Callers pass an inline arrow and an inline array, both of
 * which get a fresh identity on every render — so depending on either makes
 * the effect re-run every render, which re-sets state, which renders again.
 * M0 shipped exactly that bug: a measured 4,559 invocations in 300 ms
 * (tests/renderer/useAsync.test.tsx keeps it from coming back).
 */
function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): [T | null, string | null, () => void] {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let cancelled = false;
    fnRef
      .current()
      .then((v) => {
        if (!cancelled) {
          setValue(v);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return [value, error, useCallback(() => setNonce((n) => n + 1), [])];
}

function formatDuration(ms: number | null): string {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}

function SourceRow({ kind, source, onChange }: {
  kind: MediaKind;
  source: Source | undefined;
  onChange: () => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);

  const pick = async (): Promise<void> => {
    setBusy(true);
    try {
      const path = await window.que['sources:pickFolder'](kind);
      if (path) {
        await window.que['sources:set'](kind, path);
        onChange();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="row">
      <span className="row-label">{kind === 'video' ? 'Movies' : 'Music'}</span>
      <code className="row-value">{source?.path ?? 'not set'}</code>
      <button onClick={() => void pick()} disabled={busy}>
        {source ? 'Change' : 'Choose folder'}
      </button>
    </div>
  );
}

/**
 * The bridge is the one dependency the whole UI has. If it is missing, say so
 * plainly instead of throwing into a blank window.
 */
function BridgeMissing(): React.JSX.Element {
  return (
    <div className="fatal">
      <h1>Que can&apos;t reach its main process</h1>
      <p className="fatal-hint">
        <code>window.que</code> is undefined, which means the preload script didn&apos;t load.
        Sandboxed preloads must be CommonJS: check that <code>out/preload/index.cjs</code>{' '}
        exists, then run <code>npm run build</code> and start again. The terminal running{' '}
        <code>npm run dev</code> will have logged a <code>[preload]</code> error.
      </p>
    </div>
  );
}

export function App(): React.JSX.Element {
  if (typeof window.que === 'undefined') return <BridgeMissing />;
  return <Library />;
}

function Library(): React.JSX.Element {
  const [info] = useAsync<AppInfo>(() => window.que['app:info'](), []);
  const [sources, , reloadSources] = useAsync<Source[]>(() => window.que['sources:get'](), []);
  const [providers] = useAsync<ProviderStatus[]>(() => window.que['providers:status'](), []);

  const [query, setQuery] = useState('');
  const [items, setItems] = useState<MediaSummary[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [status, setStatus] = useState('');
  const [dragging, setDragging] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanLine, setScanLine] = useState<string | null>(null);
  const [playing, setPlaying] = useState<MediaSummary | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    if (query.trim()) {
      const results = await window.que['search:global'](query, 100);
      setItems(results);
      setTotal(results.length);
    } else {
      const page = await window.que['library:list'](DEFAULT_FILTER, DEFAULT_SORT, null);
      setItems(page.items);
      setTotal(page.total);
    }
  }, [query]);

  useEffect(() => {
    const t = setTimeout(() => void refresh(), 60); // 60ms — queries run in ~3ms
    return () => clearTimeout(t);
  }, [refresh]);

  // Scan progress arrives as events rather than polling, so a long scan
  // reports where it is without the UI asking.
  useEffect(() => {
    const off = window.que.on('scan:progress', (p) => {
      setScanLine(
        p.done
          ? null
          : `${p.scanned} scanned · ${p.added} new${p.moved ? ` · ${p.moved} moved` : ''}`
      );
    });
    return off;
  }, []);

  useEffect(() => {
    const off = window.que.on('library:changed', () => void refresh());
    return off;
  }, [refresh]);

  const scan = useCallback(
    async (full: boolean): Promise<void> => {
      setScanning(true);
      setStatus('');
      try {
        const results: ScanResult[] = await window.que['library:scan'](null, full);
        const totals = results.reduce(
          (acc, r) => ({
            added: acc.added + r.added,
            moved: acc.moved + r.moved,
            missing: acc.missing + r.missing,
            failed: acc.failed + r.failed,
            scanned: acc.scanned + r.scanned,
          }),
          { added: 0, moved: 0, missing: 0, failed: 0, scanned: 0 }
        );
        setStatus(
          `Scanned ${totals.scanned}: ${totals.added} new` +
            (totals.moved ? `, ${totals.moved} moved` : '') +
            (totals.missing ? `, ${totals.missing} now missing` : '') +
            (totals.failed ? `, ${totals.failed} failed` : '')
        );
      } catch (e) {
        setStatus(e instanceof Error ? e.message : String(e));
      } finally {
        setScanning(false);
        setScanLine(null);
        await refresh();
      }
    },
    [refresh]
  );

  const importPaths = useCallback(
    async (paths: string[]): Promise<void> => {
      if (paths.length === 0) return;
      const { imported, skipped } = await window.que['library:import'](paths);
      setStatus(`Imported ${imported}${skipped ? `, skipped ${skipped} unsupported` : ''}`);
      await refresh();
    },
    [refresh]
  );

  const onDrop = useCallback(
    (e: React.DragEvent): void => {
      e.preventDefault();
      setDragging(false);
      void importPaths(window.queFiles.pathsFor(e.dataTransfer.files));
    },
    [importPaths]
  );

  const bySource = useMemo(
    () => new Map((sources ?? []).map((s) => [s.kind, s])),
    [sources]
  );

  return (
    <div
      className={`app${dragging ? ' dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      {playing && <Player item={playing} onClose={() => setPlaying(null)} />}

      <header>
        <h1>Que</h1>
        <input
          type="search"
          placeholder="Search your library…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search library"
        />
      </header>

      <section className="panel">
        <h2>Library sources</h2>
        <SourceRow kind="video" source={bySource.get('video')} onChange={reloadSources} />
        <SourceRow kind="audio" source={bySource.get('audio')} onChange={reloadSources} />
        <div className="actions">
          <button onClick={() => void scan(false)} disabled={scanning}>
            {scanning ? 'Scanning…' : 'Scan library'}
          </button>
          <button onClick={() => void scan(true)} disabled={scanning}>
            Full rescan
          </button>
          {scanning && (
            <button onClick={() => void window.que['library:cancelScan']()}>Cancel</button>
          )}
          <button
            onClick={() =>
              void window.que['library:pickFiles']('video').then((p) => importPaths(p))
            }
            disabled={scanning}
          >
            Add videos…
          </button>
          <button
            onClick={() =>
              void window.que['library:pickFiles']('audio').then((p) => importPaths(p))
            }
            disabled={scanning}
          >
            Add music…
          </button>
          {scanLine && <span className="status">{scanLine}</span>}
          {status && !scanLine && <span className="status">{status}</span>}
        </div>
        <p className="hint">…or drop files — or a whole folder — anywhere in this window.</p>
      </section>

      <section className="panel">
        <h2>
          Catalogue{' '}
          <span className="count">
            {total === null ? '' : `${total} item${total === 1 ? '' : 's'}`}
          </span>
        </h2>
        {items.length === 0 ? (
          <p className="empty">
            {query ? 'Nothing matches that search.' : 'Nothing imported yet.'}
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Kind</th>
                <th>Year</th>
                <th>Length</th>
                <th>Rating</th>
              </tr>
            </thead>
            <tbody>
              {items.map((m) => (
                <tr key={m.id} className={m.missing ? 'missing' : undefined}>
                  <td>
                    <button className="link" onClick={() => setPlaying(m)} disabled={m.missing}>
                      {m.title}
                    </button>
                    {m.missing && <span className="badge">missing</span>}
                    {m.resumeMs !== null && m.resumeMs > 0 && (
                      <span className="badge resume">resume</span>
                    )}
                  </td>
                  <td className="dim">{m.kind}</td>
                  <td className="dim">{m.year ?? '—'}</td>
                  <td className="dim">{formatDuration(m.durationMs)}</td>
                  <td className="dim">{m.userRating ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <h2>Providers</h2>
        <p className="hint">Que runs with no API keys. Keys are an upgrade, never a requirement.</p>
        <table>
          <tbody>
            {(providers ?? []).map((p) => (
              <tr key={p.capability}>
                <td>{p.capability}</td>
                <td>
                  <strong>{p.active}</strong>
                  {p.chain.length > 1 && <span className="dim"> → {p.chain.slice(1).join(' → ')}</span>}
                </td>
                <td className="dim">{p.upgradeHint ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <footer>
        {info && (
          <span className="dim">
            Que {info.version} · Electron {info.electron} · Chromium {info.chrome} · SQLite{' '}
            {info.sqlite} · ffmpeg {info.ffmpegAvailable ? 'ready' : 'missing (npm run fetch:ffmpeg)'}
          </span>
        )}
      </footer>
    </div>
  );
}
