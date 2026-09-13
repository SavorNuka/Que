import { existsSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { app, dialog, ipcMain, type BrowserWindow } from 'electron';
import type { z } from 'zod';
import { IPC_CHANNELS, type IpcChannel, type IpcMap } from '@shared/ipc-contract';
import { argSchemas } from '@shared/schemas';
import type { MediaKind } from '@shared/types';
import { getDatabase } from '../db/connection';
import * as mediaRepo from '../db/repos/media';
import * as sourcesRepo from '../db/repos/sources';
import * as groupsRepo from '../db/repos/groups';
import * as settings from '../settings';
import * as providers from '../providers/registry';
import * as restrictions from '../restrictions';
import { ffmpegAvailable } from '../ffmpeg';

const VIDEO_EXT = new Set([
  '.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v', '.wmv', '.flv', '.mpg', '.mpeg', '.ts', '.m2ts',
]);
const AUDIO_EXT = new Set([
  '.mp3', '.flac', '.wav', '.m4a', '.aac', '.ogg', '.opus', '.wma', '.aiff',
]);

type Handlers = { [K in IpcChannel]: (...args: IpcMap[K]['args']) => Promise<IpcMap[K]['result']> };

function makeHandlers(getWindow: () => BrowserWindow | null): Handlers {
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

    async 'library:import'(paths) {
      const db = getDatabase();
      let imported = 0;
      let skipped = 0;
      db.transaction(() => {
        for (const p of paths) {
          const ext = extname(p).toLowerCase();
          const kind: MediaKind | null = VIDEO_EXT.has(ext)
            ? 'video'
            : AUDIO_EXT.has(ext)
              ? 'audio'
              : null;
          if (!kind || !existsSync(p)) {
            skipped++;
            continue;
          }
          const st = statSync(p);
          if (!st.isFile()) {
            skipped++;
            continue;
          }
          mediaRepo.insert(db, {
            kind,
            path: p,
            fileName: basename(p),
            ext,
            sizeBytes: st.size,
            mtimeMs: Math.round(st.mtimeMs),
          });
          imported++;
        }
      })();
      return { imported, skipped };
    },

    async 'library:pickFiles'(kind) {
      const win = getWindow();
      const extensions = [...(kind === 'video' ? VIDEO_EXT : AUDIO_EXT)].map((e) => e.slice(1));
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

let dbPathValue = '';
export function setDbPathForInfo(p: string): void {
  dbPathValue = p;
}
function dbPath(): string {
  return dbPathValue;
}

/**
 * Registers every channel in IPC_CHANNELS, validating arguments with the
 * matching Zod schema first. A channel with no schema is a startup error,
 * not a silently unvalidated hole.
 */
export function registerIpcHandlers(getWindow: () => BrowserWindow | null): void {
  const handlers = makeHandlers(getWindow);

  for (const channel of IPC_CHANNELS) {
    const schema = argSchemas[channel] as z.ZodType<unknown[]>;
    if (!schema) throw new Error(`No argument schema registered for IPC channel "${channel}"`);
    const handler = handlers[channel] as (...a: unknown[]) => Promise<unknown>;

    ipcMain.handle(channel, async (_event, ...rawArgs: unknown[]) => {
      const parsed = schema.safeParse(rawArgs);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
        throw new Error(`Invalid arguments for ${channel} — ${issues}`);
      }
      return handler(...(parsed.data as unknown[]));
    });
  }
}
