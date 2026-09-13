import type { ProviderStatus } from '@shared/types';
import { getKey } from '../settings';

/**
 * Capability -> ordered provider chain (ARCHITECTURE §10.0).
 *
 * Que runs with zero keys configured. A key promotes a provider to the front
 * of its chain; it never becomes the only option. Settings shows which
 * provider is actually answering, so nothing degrades silently.
 *
 * M0 ships the registry and its status reporting only — the provider
 * implementations land in M3/M4.
 */

export interface ChainEntry {
  id: string;
  requiresKey: null | 'tmdb' | 'wyzie';
  /** Shown in Settings when this provider could be improved by adding a key. */
  upgradeHint?: string;
}

const CHAINS: Record<ProviderStatus['capability'], ChainEntry[]> = {
  'movie-metadata': [
    { id: 'tmdb', requiresKey: 'tmdb' },
    {
      id: 'cinemeta',
      requiresKey: null,
      upgradeHint: 'A TMDB key improves match ranking on obscure titles.',
    },
  ],
  'movie-artwork': [
    { id: 'tmdb', requiresKey: 'tmdb' },
    {
      id: 'metahub',
      requiresKey: null,
      upgradeHint: 'A TMDB key adds multiple poster and backdrop choices.',
    },
  ],
  'movie-trailers': [
    { id: 'tmdb', requiresKey: 'tmdb' },
    { id: 'cinemeta', requiresKey: null },
  ],
  subtitles: [
    { id: 'sidecar', requiresKey: null },
    { id: 'embedded', requiresKey: null },
    { id: 'wyzie', requiresKey: 'wyzie' },
    {
      id: 'opensubtitles-v3',
      requiresKey: null,
      upgradeHint: 'A Wyzie key widens subtitle coverage considerably.',
    },
  ],
  'music-metadata': [{ id: 'musicbrainz', requiresKey: null }],
  'music-artwork': [
    { id: 'coverartarchive', requiresKey: null },
    { id: 'embedded', requiresKey: null },
    { id: 'itunes', requiresKey: null },
  ],
  lyrics: [{ id: 'lyricsovh', requiresKey: null }],
};

function available(entry: ChainEntry): boolean {
  if (entry.requiresKey === null) return true;
  return getKey(entry.requiresKey) !== null;
}

/** The chain for a capability, filtered to providers that can actually run. */
export function activeChain(capability: ProviderStatus['capability']): string[] {
  return CHAINS[capability].filter(available).map((e) => e.id);
}

export function status(): ProviderStatus[] {
  return (Object.keys(CHAINS) as ProviderStatus['capability'][]).map((capability) => {
    const chain = CHAINS[capability].filter(available);
    const active = chain[0];
    return {
      capability,
      active: active?.id ?? 'none',
      chain: chain.map((e) => e.id),
      upgradeHint: active?.upgradeHint ?? null,
    };
  });
}
