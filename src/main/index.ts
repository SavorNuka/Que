import { join } from 'node:path';
import { app, BrowserWindow, session, shell } from 'electron';
import { openDatabase, setDatabase, closeDatabase, getDatabase } from './db/connection';
import { registerIpcHandlers, setDbPathForInfo } from './ipc/handlers';
import { registerQueProtocol, registerQueScheme } from './protocol/que';
import { MediaServer } from './server/server';
import { load as loadSettings } from './settings';

// Must run before app is ready — see ASSUMPTIONS.md A3.
registerQueScheme();

let mainWindow: BrowserWindow | null = null;
const isDev = !app.isPackaged;

/**
 * Playback is served over HTTP on loopback rather than a custom protocol
 * (ASSUMPTIONS.md A2), so the app window and, later, other devices on the
 * network share one streaming path with real Range support.
 */
const mediaServer = new MediaServer(() => getDatabase());

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

  if (isDev && process.env['QUE_SMOKE'] !== '1') {
    mainWindow.webContents.openDevTools({ mode: 'right' });
  }

  if (process.env['QUE_SMOKE'] === '1') void runSmokeTest(mainWindow);

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

/**
 * Startup self-check (AAR-M0 P3).
 *
 * Exercises the real boot path — window, preload bridge, IPC, database — and
 * exits with a status. This is the gate that would have caught the blank
 * window in seconds instead of a filesystem investigation: a preload that
 * fails to load leaves window.que undefined, which fails here loudly.
 */
async function runSmokeTest(win: BrowserWindow): Promise<void> {
  const fail = (message: string): void => {
    console.error(`SMOKE FAIL: ${message}`);
    app.exit(1);
  };

  const timeout = setTimeout(() => fail('timed out waiting for the renderer'), 30_000);

  try {
    await new Promise<void>((resolve, reject) => {
      if (!win.webContents.isLoading()) return resolve();
      win.webContents.once('did-finish-load', () => resolve());
      win.webContents.once('did-fail-load', (_e, code, description) =>
        reject(new Error(`renderer failed to load: ${description} (${code})`))
      );
    });

    const bridge = (await win.webContents.executeJavaScript(
      'typeof window.que'
    )) as string;
    if (bridge !== 'object') {
      throw new Error(`preload bridge missing — typeof window.que is "${bridge}"`);
    }

    const info = (await win.webContents.executeJavaScript(
      'window.que["app:info"]()'
    )) as { sqlite: string; electron: string };
    if (!info?.sqlite) throw new Error('app:info did not answer');

    // A renderer that threw during render leaves the root element empty —
    // exactly the blank-window failure mode.
    const rendered = (await win.webContents.executeJavaScript(
      'document.getElementById("root")?.childElementCount ?? 0'
    )) as number;
    if (rendered < 1) throw new Error('the renderer mounted nothing into #root');

    clearTimeout(timeout);
    console.log(
      `SMOKE PASS: Electron ${info.electron}, SQLite ${info.sqlite}, bridge live, UI rendered`
    );
    app.exit(0);
  } catch (e) {
    clearTimeout(timeout);
    fail(e instanceof Error ? e.message : String(e));
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
  registerIpcHandlers({ getWindow: () => mainWindow, server: mediaServer });

  const { server } = loadSettings();
  if (server.enabled) {
    mediaServer
      .start(server.port, server.lanEnabled)
      .then((status) =>
        console.log(`[server] listening on ${status.host}:${status.port}`)
      )
      .catch((e: unknown) => {
        // The failure is recorded on the server's status, which the UI reads,
        // so this is no longer only a line in a terminal (AAR-M1 D4).
        console.error('[server] could not start — playback will not work:', e);
      });
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  void mediaServer.stop();
  closeDatabase();
});
