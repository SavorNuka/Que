import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * A blank window is the worst possible error message.
 *
 * Any exception thrown while rendering unmounts the whole React tree and
 * leaves the background colour and nothing else — which is exactly what a
 * failed preload looked like. This turns that into something readable.
 */

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  info: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[renderer] unhandled error', error, info.componentStack);
    this.setState({ info: info.componentStack ?? null });
  }

  override render(): ReactNode {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    const bridgeMissing = typeof window.que === 'undefined';

    return (
      <div className="fatal">
        <h1>Que hit an error while starting</h1>

        {bridgeMissing && (
          <p className="fatal-hint">
            <strong>The preload bridge didn&apos;t load.</strong> The renderer has no{' '}
            <code>window.que</code>, so nothing can talk to the main process. Check that{' '}
            <code>out/preload/index.cjs</code> exists and is CommonJS — sandboxed preloads
            cannot be ES modules. Rebuild with <code>npm run build</code>.
          </p>
        )}

        <pre className="fatal-error">{error.stack ?? String(error)}</pre>
        {info && <pre className="fatal-stack">{info}</pre>}

        <p className="fatal-hint">
          The DevTools console (open on the right in development) usually has more.
        </p>
      </div>
    );
  }
}
