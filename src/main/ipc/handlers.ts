import { existsSync, statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { app, dialog, ipcMain, type BrowserWindow } from 'electron';
import type { z } from 'zod';
import {
  IPC_CHANNELS,
  type EventMap,
  type EventName,
  type IpcChannel,
  type IpcMap,
} from '@shared/ipc-contract';
import { argSchemas } from '@shared/schemas';
import { getDatabase } from '../db/connection';
import * as mediaRepo from '../db/repos/media';
import * as sourcesRepo from '../db/repos/sources';
import * as groupsRepo from '../db/repos/groups';
import * as settings from '../settings';
import * as providers from '../providers/registry';
import * as restrictions from '../restrictions';
import { ffmpegAvailable } from '../ffmpeg';
import { importPaths, scanSource } from '../library/scanner';
import { AUDIO_EXTENSIONS, VIDEO_EXTENSIONS } from '../library/walk';
import type { MediaServer } from '../server/server';
import { mediaWorkBudget } from '../transcode/budget';

type Handlers = { [K in IpcChannel]: (...args: IpcMap[K]['args']) => Promise<IpcMap[K]['result']> };

export interface HandlerDeps {
  getWindow: () => BrowserWindow | null;
  server: MediaServer;
}

function makeHandlers({ getWindow, server }: HandlerDeps): Handlers {
  /**
   * A scan runs in main and can take minutes on a large library, so exactly
   * one runs at a time and it is cancellable. These live in the closure rather
   * than at module scope: as module state they would leak between dispatchers,
   * which is how "a scan is already running" turns into a test-order-dependent
   * failure and, in the app, into a scan button that stays dead after a reload.
   */
  let scanCancelled = false;
  let scanRunning = false;

  return {
    async 'app:info'() {
      const db = getDatabase();
      const { v } = db.prepare('select sqlite_version() as v').get() as { v: string };
      return {
        version: app.getVersion(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        sqlite: v,
        dbPath: dbPath(),
        userDataPath: app.getPath('userData'),
        ffmpegAvailable: ffmpegAvailable(),
      };
    },

    async 'sources:get'() {
      return sourcesRepo.getAll(getDatabase());
    },

    async 'sources:set'(kind, path) {
      if (!existsSync(path) || !statSync(path).isDirectory()) {
        throw new Error('That path is not a folder on this machine');
      }
      return sourcesRepo.set(getDatabase(), kind, path);
    },

    async 'sources:pickFolder'(kind) {
      const win = getWindow();
      const result = await dialog.showOpenDialog(win!, {
        title: kind === 'video' ? 'Choose your movies folder' : 'Choose your music folder',
        properties: ['openDirectory', 'dontAddToRecent'],
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },

    async 'library:list'(filter, sort, cursor) {
      return mediaRepo.list(getDatabase(), filter, sort, cursor);
    },

    async 'library:get'(id) {
      return mediaRepo.get(getDatabase(), id);
    },

    /**
     * Dropping a FOLDER walks it recursively rather than skipping it, which is
     * what anyone dropping a season folder expects (AAR-M0 D4).
     */
    async 'library:import'(paths) {
      const db = getDatabase();
      const { imported, skipped } = await importPaths(db, paths, {
        stat: async (p) => {
          try {
            const st = await stat(p);
            return { isDirectory: st.isDirectory(), size: st.size, mtimeMs: st.mtimeMs };
          } catch {
            return null;
          }
        },
        budget: mediaWorkBudget,
      });
      emit('library:changed', { reason: 'import' });
      return { imported, skipped };
    },

    async 'library:scan'(kind, full) {
      if (scanRunning) throw new Error('A scan is already running');
      const db = getDatabase();
      const sources = sourcesRepo.getAll(db).filter((s) => s.enabled && (!kind || s.kind === kind));
      if (sources.length === 0) {
        throw new Error(
          kind
            ? `No ${kind === 'video' ? 'movies' : 'music'} folder is set — choose one first`
            : 'No library folders are set — choose one first'
        );
      }

      scanRunning = true;
      scanCancelled = false;
      try {
        const results = [];
        for (const source of sources) {
          results.push(
            await scanSource(db, source, {
              full,
              isCancelled: () => scanCancelled,
              onProgress: (p) => emit('scan:progress', p),
              budget: mediaWorkBudget,
            })
          );
        }
        emit('library:changed', { reason: 'scan' });
        return results;
      } finally {
        scanRunning = false;
      }
    },

    async 'library:cancelScan'() {
      scanCancelled = true;
    },

    async 'library:pickFiles'(kind) {
      const win = getWindow();
      const extensions = [...(kind === 'video' ? VIDEO_EXTENSIONS : AUDIO_EXTENSIONS)].map((e) =>
        e.slice(1)
      );
      const result = await dialog.showOpenDialog(win!, {
        title: kind === 'video' ? 'Add videos' : 'Add music',
        properties: ['openFile', 'multiSelections', 'dontAddToRecent'],
        filters: [
          { name: kind === 'video' ? 'Video' : 'Audio', extensions },
          { name: 'All files', extensions: ['*'] },
        ],
      });
      return result.canceled ? [] : result.filePaths;
    },

    async 'library:setRating'(id, rating) {
      mediaRepo.setRating(getDatabase(), id, rating);
    },

    async 'library:setFields'(id, patch) {
      return mediaRepo.setFields(getDatabase(), id, patch);
    },

    /**
     * §23. Hiding something is always allowed; UNhiding, lowering the age
     * limit, or changing the PIN requires an unlocked session. Otherwise the
     * lock would be trivially removable from the UI it is meant to govern.
     */
    async 'library:setHidden'(id, hidden) {
      if (!hidden) requireUnlocked();
      mediaRepo.setHidden(getDatabase(), id, hidden);
    },

    async 'library:setAgeRating'(id, ageMin) {
      requireUnlocked();
      mediaRepo.setAgeRating(getDatabase(), id, ageMin);
    },

    async 'media:streamUrl'(id) {
      // Throws if the item is restricted or missing — resolve() applies §23.
      mediaRepo.get(getDatabase(), id);
      return server.urlFor(id);
    },

    async 'player:progress'(id, positionMs) {
      mediaRepo.setProgress(getDatabase(), id, positionMs);
    },

    async 'player:finished'(id) {
      mediaRepo.markFinished(getDatabase(), id);
    },

    async 'server:status'() {
      return server.status();
    },

    async 'restrictions:get'() {
      return restrictions.publicState();
    },

    async 'restrictions:set'(patch) {
      requireUnlocked();
      settings.setRestrictions(patch);
      return restrictions.publicState();
    },

    async 'restrictions:setPin'(pin) {
      requireUnlocked();
      settings.setPinRecord(pin === null ? null : restrictions.createPinRecord(pin));
      return restrictions.publicState();
    },

    async 'restrictions:unlock'(pin) {
      if (!restrictions.unlock(pin)) throw new Error('Incorrect PIN');
      return restrictions.publicState();
    },

    async 'restrictions:lock'() {
      restrictions.lock();
      return restrictions.publicState();
    },

    async 'search:global'(q, limit) {
      // Goes through the repo so it inherits the restriction clauses (§23).
      return mediaRepo.searchRanked(getDatabase(), q, limit);
    },

    async 'groups:list'(kind, parentId) {
      return groupsRepo.list(getDatabase(), kind, parentId);
    },

    async 'groups:get'(id) {
      return groupsRepo.get(getDatabase(), id);
    },

    async 'groups:setScreen'(id, screen) {
      return groupsRepo.setScreen(getDatabase(), id, screen);
    },

    async 'groups:setFavorite'(id, favorite) {
      return groupsRepo.setFavorite(getDatabase(), id, favorite);
    },

    async 'settings:get'() {
      return settings.publicSettings();
    },

    async 'settings:set'(patch) {
      return settings.update(patch);
    },

    async 'settings:setKey'(which, value) {
      return settings.setKey(which, value);
    },

    async 'providers:status'() {
      return providers.status();
    },
  };
}

/**
 * Guard for anything that would weaken restrictions. No-op while restrictions
 * are off, so the app is not annoying for people who never turn them on.
 */
function requireUnlocked(): void {
  if (restrictions.isActive()) {
    throw new Error('Restricted — unlock with your PIN first');
  }
}

/** Push an event to the renderer. Silent when the window is gone. */
let emitTo: (() => BrowserWindow | null) | null = null;
function emit<E extends EventName>(event: E, payload: EventMap[E]): void {
  const win = emitTo?.();
  if (win && !win.isDestroyed()) win.webContents.send(event, payload);
}

let dbPathValue = '';
export function setDbPathForInfo(p: string): void {
  dbPathValue = p;
}
function dbPath(): string {
  return dbPathValue;
}

export type Dispatch = <K extends IpcChannel>(
  channel: K,
  ...rawArgs: unknown[]
) => Promise<IpcMap[K]['result']>;

/**
 * Validate-then-handle, in one place.
 *
 * AAR-M1 P1: M1 shipped 30 argument-validation tests and no round-trips, so
 * nothing tested that a validated call actually reaches the right repository
 * and returns the right shape. Extracting the dispatch means the round-trip
 * tests exercise the real path — schema, error text and all — rather than a
 * copy of it that can drift from what `ipcMain` actually runs.
 */
export function createDispatch(deps: HandlerDeps): Dispatch {
  const handlers = makeHandlers(deps);

  return async <K extends IpcChannel>(channel: K, ...rawArgs: unknown[]) => {
    const schema = argSchemas[channel] as z.ZodType<unknown[]> | undefined;
    if (!schema) throw new Error(`No argument schema registered for IPC channel "${channel}"`);

    const parsed = schema.safeParse(rawArgs);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new Error(`Invalid arguments for ${channel} — ${issues}`);
    }

    const handler = handlers[channel] as (...a: unknown[]) => Promise<IpcMap[K]['result']>;
    return handler(...(parsed.data as unknown[]));
  };
}

/**
 * Registers every channel in IPC_CHANNELS. A channel with no schema is a
 * startup error, not a silently unvalidated hole.
 */
export function registerIpcHandlers(deps: HandlerDeps): void {
  emitTo = deps.getWindow;
  const dispatch = createDispatch(deps);

  for (const channel of IPC_CHANNELS) {
    if (!argSchemas[channel]) throw new Error(`No argument schema registered for IPC channel "${channel}"`);
    ipcMain.handle(channel, async (_event, ...rawArgs: unknown[]) => dispatch(channel, ...rawArgs));
  }
}
