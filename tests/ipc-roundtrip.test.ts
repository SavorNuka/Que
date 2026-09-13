import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * IPC round-trips — the unmet half of M1 scope item 8 (AAR-M1 P1).
 *
 * M1 shipped 30 argument-validation tests and no round-trips, so nothing
 * tested that a *valid* call reaches the right repository and comes back in
 * the right shape. These go through `createDispatch`, which is the same
 * function `registerIpcHandlers` gives to `ipcMain` — so the validation, the
 * error text and the handler body are all the real ones.
 *
 * The two cases AAR-M1 named specifically are `library:scan` refusing a
 * concurrent scan and `media:streamUrl` refusing a restricted id. Both are
 * here.
 */

// vi.mock is hoisted above every import, so the factory must not close over
// anything declared in this file.
vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.1.0-test',
    getPath: () => '/tmp/que-test-userdata',
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
  dialog: {
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
  },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: class {},
}));

vi.mock('../src/main/settings', () => ({
  publicSettings: () => ({ theme: 'system' }),
  update: (patch: Record<string, unknown>) => ({ theme: 'system', ...patch }),
  setKey: () => ({ hasTmdbKey: false, hasWyzieKey: false }),
  setRestrictions: vi.fn(),
  setPinRecord: vi.fn(),
  getKey: () => null,
}));

import type { Db } from '../src/main/db/connection';
import { setDatabase } from '../src/main/db/connection';
import { reindexMedia } from '../src/main/db/search';
import { createDispatch, type Dispatch } from '../src/main/ipc/handlers';
import * as restrictions from '../src/main/restrictions';
import { MediaServer } from '../src/main/server/server';
import { freshDb } from './helpers/db';

const UNRESTRICTED = {
  enabled: false,
  maxAge: 18,
  allowUnrated: true,
  blockExplicit: false,
  pinSet: false,
  unlockMinutes: 30,
};

describe('IPC round-trips', () => {
  let db: Db;
  let server: MediaServer;
  let dispatch: Dispatch;

  const addMedia = (title: string, opts: { hidden?: boolean; ageMin?: number } = {}): number => {
    const info = db
      .prepare(
        `INSERT INTO media (kind, path, file_name, ext, added_at, title, sort_title, hidden, age_min, duration_ms)
         VALUES ('video', ?, 'x.mp4', '.mp4', ?, ?, ?, ?, ?, 120000)`
      )
      .run(
        `/m/${title}.mp4`,
        Date.now(),
        title,
        title.toLowerCase(),
        opts.hidden ? 1 : 0,
        opts.ageMin ?? null
      );
    const id = Number(info.lastInsertRowid);
    // Inserted with raw SQL rather than through the scanner, so the FTS index
    // has to be told. Without this the search round-trips pass vacuously.
    reindexMedia(db, id);
    return id;
  };

  beforeEach(async () => {
    db = freshDb();
    setDatabase(db);
    restrictions.configure(UNRESTRICTED, null);

    server = new MediaServer(() => db);
    await server.start(0);

    dispatch = createDispatch({ getWindow: () => null, server });
  });

  afterEach(async () => {
    await server.stop();
    restrictions.configure(UNRESTRICTED, null);
    db.close();
  });

  describe('library', () => {
    it('lists what was inserted, with a total', async () => {
      addMedia('alpha');
      addMedia('beta');

      const page = await dispatch('library:list', { match: 'all' }, { key: 'title', dir: 'asc' }, null);
      expect(page.total).toBe(2);
      expect(page.items.map((m) => m.title)).toEqual(['alpha', 'beta']);
    });

    it('fetches one item by id', async () => {
      const id = addMedia('gamma');
      const detail = await dispatch('library:get', id);
      expect(detail.id).toBe(id);
      expect(detail.title).toBe('gamma');
    });

    it('rejects a malformed id before the handler ever runs', async () => {
      await expect(dispatch('library:get', 1.5)).rejects.toThrow(/Invalid arguments for library:get/);
    });

    it('round-trips a rating through set and read', async () => {
      const id = addMedia('delta');
      await dispatch('library:setRating', id, 4);
      expect((await dispatch('library:get', id)).userRating).toBe(4);
    });

    it('round-trips a custom field', async () => {
      const id = addMedia('epsilon');
      const updated = await dispatch('library:setFields', id, { director: 'Kurosawa' });
      expect(updated.fields).toMatchObject({ director: 'Kurosawa' });
      expect((await dispatch('library:get', id)).fields).toMatchObject({ director: 'Kurosawa' });
    });

    it('clears a custom field when the value is null', async () => {
      const id = addMedia('eta');
      await dispatch('library:setFields', id, { director: 'Kurosawa' });
      const cleared = await dispatch('library:setFields', id, { director: null });
      expect(cleared.fields).not.toHaveProperty('director');
    });

    /**
     * AAR-M1b D2. ARCHITECTURE §6 documents this channel as "first-class +
     * custom", but the handler writes every key to `media_fields`, so a patch
     * naming a real column is stored as a custom field that the column then
     * shadows — it looks saved and is not. Owned by M3, where the metadata
     * editor lands; asserted here so the gap is visible rather than assumed
     * fixed. Delete this test when M3 makes it wrong.
     */
    it('KNOWN GAP: a first-class column is stored as a shadowed custom field', async () => {
      const id = addMedia('epsilon-first-class');
      const updated = await dispatch('library:setFields', id, { title: 'Renamed' });

      expect(updated.title).toBe('epsilon-first-class');
      expect(updated.fields).toMatchObject({ title: 'Renamed' });
    });

    it('refuses a rating outside the scale', async () => {
      const id = addMedia('zeta');
      await expect(dispatch('library:setRating', id, 11)).rejects.toThrow(/Invalid arguments/);
    });
  });

  describe('search', () => {
    it('finds an item through the ranked search path', async () => {
      addMedia('the matrix');
      addMedia('blade runner');

      const results = await dispatch('search:global', 'matrix', 10);
      expect(results.map((m) => m.title)).toEqual(['the matrix']);
    });

    it('returns nothing rather than throwing for a query that matches nothing', async () => {
      addMedia('the matrix');
      expect(await dispatch('search:global', 'nonexistent', 10)).toEqual([]);
    });

    /**
     * AAR-M1 recorded that `search:global` once bypassed the restriction
     * clauses entirely. This is the round-trip that would have caught it.
     */
    it('does not surface a restricted item', async () => {
      addMedia('forbidden feature', { ageMin: 18 });
      restrictions.configure({ ...UNRESTRICTED, enabled: true, maxAge: 13 }, null);

      expect(await dispatch('search:global', 'forbidden', 10)).toEqual([]);
    });
  });

  describe('scanning', () => {
    it('refuses to scan when no source folder is set, and says why', async () => {
      await expect(dispatch('library:scan', null, false)).rejects.toThrow(/No library folders are set/);
    });

    /**
     * AAR-M1 P1 named this one. Two scans at once would double-probe every
     * file and interleave the missing sweep with the walk.
     */
    it('refuses a second scan while one is running', async () => {
      db.prepare(`INSERT INTO sources (kind, path, enabled) VALUES ('video', ?, 1)`).run('/nonexistent-folder');

      const first = dispatch('library:scan', null, false);
      const second = dispatch('library:scan', null, false);

      await expect(second).rejects.toThrow(/already running/);
      await first;
    });

    it('allows a scan again once the first has finished', async () => {
      db.prepare(`INSERT INTO sources (kind, path, enabled) VALUES ('video', ?, 1)`).run('/nonexistent-folder');

      await dispatch('library:scan', null, false);
      await expect(dispatch('library:scan', null, false)).resolves.toBeInstanceOf(Array);
    });

    it('cancelScan is safe to call when nothing is running', async () => {
      await expect(dispatch('library:cancelScan')).resolves.toBeUndefined();
    });
  });

  describe('playback', () => {
    it('mints a stream URL carrying the id and a token', async () => {
      const id = addMedia('playable');
      const url = await dispatch('media:streamUrl', id);

      expect(url).toContain(`/stream/${String(id)}`);
      expect(url).toMatch(/[?&]t=/);
    });

    /**
     * The other case AAR-M1 named. Restricted items must not merely be
     * unlisted — a client that already knows the id must not be handed a URL.
     */
    it('refuses a stream URL for a restricted id', async () => {
      const id = addMedia('adults only', { ageMin: 18 });
      restrictions.configure({ ...UNRESTRICTED, enabled: true, maxAge: 13 }, null);

      await expect(dispatch('media:streamUrl', id)).rejects.toThrow();
    });

    it('refuses a stream URL for an id that does not exist', async () => {
      await expect(dispatch('media:streamUrl', 99_999)).rejects.toThrow();
    });

    it('round-trips playback progress into a resume position', async () => {
      const id = addMedia('resumable');
      await dispatch('player:progress', id, 60_000);
      expect((await dispatch('library:get', id)).resumeMs).toBe(60_000);
    });

    it('clears resume and counts the play when finished', async () => {
      const id = addMedia('finishable');
      await dispatch('player:progress', id, 60_000);
      await dispatch('player:finished', id);

      const detail = await dispatch('library:get', id);
      expect(detail.resumeMs).toBeNull();
      expect(detail.playCount).toBe(1);
    });
  });

  describe('restrictions', () => {
    it('reports public state without leaking the PIN', async () => {
      const state = await dispatch('restrictions:get');
      expect(state).not.toHaveProperty('pin');
      expect(state).not.toHaveProperty('hash');
    });

    it('allows hiding while locked, but not unhiding', async () => {
      const id = addMedia('to hide');
      restrictions.configure({ ...UNRESTRICTED, enabled: true, maxAge: 18, pinSet: true }, {
        salt: 'x',
        hash: 'y',
        n: 16384,
        r: 8,
        p: 1,
      } as never);

      await expect(dispatch('library:setHidden', id, true)).resolves.toBeUndefined();
      await expect(dispatch('library:setHidden', id, false)).rejects.toThrow(/unlock/i);
    });

    it('rejects an incorrect PIN once one is set', async () => {
      restrictions.configure(
        { ...UNRESTRICTED, enabled: true, pinSet: true },
        restrictions.createPinRecord('1234')
      );

      await expect(dispatch('restrictions:unlock', '9999')).rejects.toThrow(/Incorrect PIN/);
      await expect(dispatch('restrictions:unlock', '1234')).resolves.toMatchObject({ unlocked: true });
    });

    /** Documented behaviour, asserted so it stays deliberate: with no PIN
     * configured there is nothing to verify, so unlocking succeeds — but it is
     * still a time-limited session rather than a permanent state. */
    it('allows unlocking when no PIN is configured', async () => {
      await expect(dispatch('restrictions:unlock', 'anything')).resolves.toBeTruthy();
    });
  });

  describe('status channels', () => {
    it('reports server status with the port it actually bound', async () => {
      const status = await dispatch('server:status');
      expect(status.running).toBe(true);
      expect(status.port).toBeGreaterThan(0);
    });

    it('reports the provider chain, key-free by default', async () => {
      const providers = await dispatch('providers:status');
      expect(providers.length).toBeGreaterThan(0);
      expect(providers.every((p) => p.active !== 'none')).toBe(true);
    });

    it('rejects an unknown channel rather than dispatching it', async () => {
      await expect(dispatch('not:a:channel' as never)).rejects.toThrow(/No argument schema/);
    });
  });

  describe('dispatcher isolation', () => {
    /**
     * Scan state used to live at module scope, so one dispatcher's running
     * scan blocked another's — invisible in the app, and a test-order-
     * dependent failure here.
     */
    it('gives each dispatcher its own scan state', async () => {
      db.prepare(`INSERT INTO sources (kind, path, enabled) VALUES ('video', ?, 1)`).run('/nonexistent-folder');
      const other = createDispatch({ getWindow: () => null, server });

      const first = dispatch('library:scan', null, false);
      await expect(other('library:scan', null, false)).resolves.toBeInstanceOf(Array);
      await first;
    });
  });
});
