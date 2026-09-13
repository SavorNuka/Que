import { join } from 'node:path';
import { app, BrowserWindow, session, shell } from 'electron';
import { openDatabase, setDatabase, closeDatabase } from './db/connection';
import { registerIpcHandlers, setDbPathForInfo } from './ipc/handlers';
import { registerQueProtocol, registerQueScheme } from './protocol/que';
import { load as loadSettings } from './settings';

// Must run before app is ready — see ASSUMPTIONS.md A3.
registerQueScheme();

let mainWindow: BrowserWindow | null = null;
const isDev = !app.isPackaged;

/**
 * Renderer CSP.
 *
 * media-src allows http://127.0.0.1 because playback is served by the local
 * HTTP server rather than a custom protocol (ASSUMPTIONS.md A2/A5) — that gives
 * real Range handling and makes the LAN server and local player one code path.
 * connect-src allows the same origin for the library API the web client uses.
 */
function contentSecurityPolicy(): string {
  const devScript = isDev ? " 'unsafe-inline'" : '';
  return [
    "default-src 'none'",
    `script-src 'self'${devScript}`,
    "style-src 'self' 'unsafe-inline'",
    'img-src que: data: blob:',
    'font-src que: data:',
    'media-src que: blob: http://127.0.0.1:* http://localhost:*',
    `connect-src 'self' http://127.0.0.1:* http://localhost:*${isDev ? ' ws://localhost:*' : ''}`,
    "form-action 'none'",
    "base-uri 'none'",
    "frame-src 'self' que:",
    "object-src 'none'",
  ].join('; ');
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 940,
    minHeight: 600,
    show: false,
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    title: 'Que',
    webPreferences: {
      // .cjs — sandboxed preloads cannot be ESM. See electron.vite.config.ts.
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  /**
   * Failure diagnostics.
   *
   * A renderer or preload that dies silently shows an empty window, which is
   * the least useful error message there is. These turn every such failure
   * into something that names itself.
   */
  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error(`[preload] failed to load ${preloadPath}\n`, error);
  });

  mainWindow.webContents.on('did-fail-load', (_e, code, description, url) => {
    console.error(`[renderer] failed to load ${url} — ${description} (${code})`);
  });

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer] process gone:', details.reason, details.exitCode);
  });

  // Object-form listener: the positional (level, message, line, sourceId)
  // signature is deprecated and warns at runtime.
  mainWindow.webContents.on('console-message', (details) => {
    if (details.level === 'error' || details.level === 'warning') {
      console.error(
        `[renderer console] ${details.message} (${details.sourceId}:${details.lineNumber})`
      );
    }
  });

  if (isDev) mainWindow.webContents.openDevTools({ mode: 'right' });

  // Nothing in this app opens a new window; external links go to the OS browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  // And nothing navigates away from the app shell.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devServer = process.env['ELECTRON_RENDERER_URL'];
    if (devServer && url.startsWith(devServer)) return;
    event.preventDefault();
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
  });

  const devServer = process.env['ELECTRON_RENDERER_URL'];
  if (isDev && devServer) {
    void mainWindow.loadURL(devServer);
  } else {
    void mainWindow.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }
}

function applySecurityHeaders(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [contentSecurityPolicy()],
        'X-Content-Type-Options': ['nosniff'],
      },
    });
  });

  // No renderer needs a camera, a microphone, or your location.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false);
  });
}

app.whenReady().then(() => {
  const dbPath = join(app.getPath('userData'), 'que.db');
  setDbPathForInfo(dbPath);
  setDatabase(openDatabase(dbPath));
  loadSettings();

  applySecurityHeaders();
  registerQueProtocol();
  registerIpcHandlers(() => mainWindow);

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  closeDatabase();
});
