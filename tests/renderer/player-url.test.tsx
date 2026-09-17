// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { seekPlaylistUrl } from '../../src/renderer/src/app/Player';

/**
 * Regression guard: `seekPlaylistUrl` must stay absolute.
 *
 * `hls.loadSource()` resolves a relative URL against the renderer's OWN page
 * origin (`file://`, or the dev server's), never the media server's — the
 * same class of bug AAR-M1c already found and fixed for the base hlsUrl.
 * Reintroduced here, it surfaced only against a real dev server, where
 * hls.js received the page's own index.html back and failed with
 * ManifestParsingError rather than a clean network error — invisible to a
 * test that only checks the string shape rather than that it survives a
 * same-origin `new URL()` round trip.
 */
describe('seekPlaylistUrl', () => {
  it('stays absolute, pointing at the media server, not the page', () => {
    const base = 'http://127.0.0.1:8723/hls/4/playlist.m3u8?t=abc123';
    const result = seekPlaylistUrl(base, 90);

    expect(result).toBe('http://127.0.0.1:8723/hls/4/seek/90/playlist.m3u8?t=abc123');
    // The failure mode this guards: window.location.href — a *different*
    // origin — swallowing the media server's origin.
    expect(new URL(result).origin).toBe('http://127.0.0.1:8723');
  });

  it('buckets to the nearest SEEK_BUCKET_SECONDS below the target', () => {
    const base = 'http://127.0.0.1:8723/hls/4/playlist.m3u8?t=abc123';
    expect(seekPlaylistUrl(base, 91)).toContain('/seek/90/');
    expect(seekPlaylistUrl(base, 89)).toContain('/seek/84/');
  });

  it('floors a negative or tiny target at 0', () => {
    const base = 'http://127.0.0.1:8723/hls/4/playlist.m3u8?t=abc123';
    expect(seekPlaylistUrl(base, 0)).toContain('/seek/0/');
    expect(seekPlaylistUrl(base, -5)).toContain('/seek/0/');
  });
});
