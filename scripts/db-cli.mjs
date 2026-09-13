#!/usr/bin/env node
/**
 * Database maintenance without launching the app.
 *   node scripts/db-cli.mjs path|migrate|reset|reindex|vacuum|stats
 *
 * Resolves the same userData location Electron uses, so it operates on the
 * real database rather than a copy.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import Database from 'better-sqlite3';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = join(root, 'src', 'main', 'db', 'migrations');

function userDataDir() {
  const name = 'Que';
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), name);
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', name);
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), name);
}

const DB_PATH = join(userDataDir(), 'que.db');

function open({ create = true } = {}) {
  if (!create && !existsSync(DB_PATH)) {
    console.error(`No database at ${DB_PATH} — start Que once, or run "npm run db:migrate".`);
    process.exit(1);
  }
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const row = db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get();
  const current = row ? parseInt(row.value, 10) : 0;
  let applied = 0;
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    const n = parseInt(file.slice(0, 3), 10);
    if (n <= current) continue;
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare(
        `INSERT INTO meta (key,value) VALUES ('schema_version',?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`
      ).run(String(n));
    })();
    console.log(`  applied ${file}`);
    applied++;
  }
  const final = db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get();
  console.log(`schema_version = ${final?.value ?? 0}${applied ? '' : ' (already current)'}`);
}

/** Mirrors src/main/db/search.ts — kept deliberately simple and dependency-free. */
function reindex(db) {
  const ids = db.prepare('SELECT id FROM media').all();
  const gather = db.prepare(
    `SELECT m.id AS rowid,
            COALESCE(m.title, m.file_name) AS title,
            COALESCE(m.overview,'')        AS overview,
            COALESCE(a.artist,'')          AS artist,
            COALESCE(a.album,'')           AS album,
            COALESCE(v.series_title,'')    AS series_title,
            COALESCE(m.genres,'')          AS genres
       FROM media m
       LEFT JOIN audio_meta a ON a.media_id=m.id
       LEFT JOIN video_meta v ON v.media_id=m.id
      WHERE m.id=?`
  );
  const fields = db.prepare('SELECT value FROM media_fields WHERE media_id=?');
  const ins = db.prepare(
    `INSERT INTO media_fts (rowid,title,overview,artist,album,series_title,genres,custom)
     VALUES (@rowid,@title,@overview,@artist,@album,@series_title,@genres,@custom)`
  );
  db.transaction(() => {
    db.exec('DELETE FROM media_fts');
    for (const { id } of ids) {
      const row = gather.get(id);
      if (!row) continue;
      row.custom = fields.all(id).map((f) => f.value ?? '').join(' ');
      ins.run(row);
    }
  })();
  console.log(`reindexed ${ids.length} rows`);
}

function stats(db) {
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all();
  const width = Math.max(...tables.map((t) => t.name.length));
  for (const { name } of tables) {
    let count = '—';
    try {
      count = String(db.prepare(`SELECT count(*) c FROM "${name}"`).get().c);
    } catch {
      /* fts shadow tables */
    }
    console.log(`  ${name.padEnd(width)}  ${count.padStart(8)}`);
  }
  const page = db.pragma('page_count', { simple: true });
  const size = db.pragma('page_size', { simple: true });
  console.log(`\n  database ${(page * size / 1048576).toFixed(2)} MB at ${DB_PATH}`);
}

const command = process.argv[2] ?? 'path';

switch (command) {
  case 'path':
    console.log(DB_PATH);
    break;

  case 'migrate': {
    const db = open();
    migrate(db);
    db.close();
    break;
  }

  case 'reset': {
    if (existsSync(DB_PATH)) {
      const backup = DB_PATH.replace(/\.db$/, `-${Date.now()}.db.bak`);
      copyFileSync(DB_PATH, backup);
      console.log(`backed up to ${backup}`);
      for (const suffix of ['', '-wal', '-shm']) rmSync(DB_PATH + suffix, { force: true });
    }
    const db = open();
    migrate(db);
    db.close();
    console.log('database recreated empty');
    break;
  }

  case 'reindex': {
    const db = open({ create: false });
    reindex(db);
    db.close();
    break;
  }

  case 'vacuum': {
    const db = open({ create: false });
    db.exec('VACUUM');
    db.exec('ANALYZE');
    db.close();
    console.log('vacuumed and analyzed');
    break;
  }

  case 'stats': {
    const db = open({ create: false });
    stats(db);
    db.close();
    break;
  }

  default:
    console.error(`Unknown command "${command}". Use: path | migrate | reset | reindex | vacuum | stats`);
    process.exit(1);
}
