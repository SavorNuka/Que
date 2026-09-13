// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Regression guard for the M0 AAR's most serious finding.
 *
 * The original hook depended on `fn` and on the caller's `deps` ARRAY object.
 * Callers pass an inline arrow and an inline `[]`, both freshly allocated on
 * every render, so the effect re-ran every render, set state, and rendered
 * again — measured at 4,559 invocations in 300 ms, across three mounted hooks.
 *
 * This is a copy of the shipped hook rather than an import because App.tsx
 * needs `window.que` to render. If you change useAsync in App.tsx, change it
 * here too — the assertion below is what keeps the bug from returning.
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

describe('useAsync', () => {
  it('invokes its function once for stable deps, not once per render', async () => {
    const spy = vi.fn(async () => ({ version: '0.1.0' }));

    function Probe(): React.JSX.Element {
      const [info] = useAsync(() => spy(), []);
      return <div>{info ? info.version : 'loading'}</div>;
    }

    const { findByText } = render(<Probe />);
    await findByText('0.1.0');
    // Leave room for a runaway loop to show itself.
    await new Promise((r) => setTimeout(r, 300));

    expect(spy.mock.calls.length).toBe(1);
  });

  it('re-runs when a dependency actually changes', async () => {
    const spy = vi.fn(async (q: string) => `result:${q}`);

    function Probe({ q }: { q: string }): React.JSX.Element {
      const [value] = useAsync(() => spy(q), [q]);
      return <div>{value ?? 'loading'}</div>;
    }

    const { rerender, findByText } = render(<Probe q="a" />);
    await findByText('result:a');
    rerender(<Probe q="b" />);
    await findByText('result:b');
    await waitFor(() => expect(spy.mock.calls.length).toBe(2));
  });

  it('surfaces a rejection as an error rather than throwing', async () => {
    const spy = vi.fn(async () => {
      throw new Error('ipc exploded');
    });

    function Probe(): React.JSX.Element {
      const [, error] = useAsync(spy, []);
      return <div>{error ?? 'no error'}</div>;
    }

    const { findByText } = render(<Probe />);
    await findByText('ipc exploded');
  });
});
