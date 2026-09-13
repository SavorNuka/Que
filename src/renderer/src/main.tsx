import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { ErrorBoundary } from './app/ErrorBoundary';
import './styles.css';

const el = document.getElementById('root');
if (!el) throw new Error('#root missing from index.html');

// Anything that escapes React still needs to be visible rather than blank.
window.addEventListener('error', (e) => console.error('[renderer] uncaught', e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) =>
  console.error('[renderer] unhandled rejection', e.reason)
);

createRoot(el).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
);
