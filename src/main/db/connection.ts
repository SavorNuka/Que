import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

export type Db = Database.Database;

/**
 * contentless_delete=1 (used by media_fts) landed in SQLite 3.45.
 * Without it the search index can be written but never updated —
 * see docs/ASSUMPTIONS.md A1.
 */
const MIN_SQLITE = [3, 45, 0] as const;

let db: Db | null = null;

function migrationsDir(): string {
  // Resolved relative to the bundled main entry at runtime, and to this
  // file when running under vitest.
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    join(here, 'migrations'),
    join(here, 'db', 'migrations'),
    join(here, '..', 'db', 'migrations'),
    join(process.cwd(), 'src', 'main', 'db', 'migrations'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('Could not locate db/migrations directory');
}

function assertSqliteVersion(conn: Db): void {
  const v = conn.prepare('select sqlite_version() as v').get() as { v: string };
  const [major = 0, minor = 0, patch = 0] = v.v.split('.').map((n) => parseInt(n, 10) || 0);
  const ok =
    major > MIN_SQLITE[0] ||
    (major === MIN_SQLITE[0] &&
      (minor > MIN_SQLITE[1] || (minor === MIN_SQLITE[1] && patch >= MIN_SQLITE[2])));
  if (!ok) {
    throw new Error(
      `Que needs SQLite >= ${MIN_SQLITE.join('.')} for contentless_delete FTS5; found ${v.v}`
    );
  }
}

export function applyMigrations(conn: Db): number {
  conn.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const row = conn.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get() as
    | { value: string }
    | undefined;
  const current = row ? parseInt(row.value, 10) : 0;

  const files = readdirSync(migrationsDir())
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let version = current;
  for (const file of files) {
    const n = parseInt(file.slice(0, 3), 10);
    if (Number.isNaN(n)) throw new Error(`Migration ${file} must start with a 3-digit number`);
    if (n <= current) continue;
    const sql = readFileSync(join(migrationsDir(), file), 'utf8');
    conn.transaction(() => {
      conn.exec(sql);
      conn
        .prepare(`INSERT INTO meta (key,value) VALUES ('schema_version',?)
                  ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
        .run(String(n));
    })();
    version = n;
  }
  return version;
}

export function openDatabase(path: string): Db {
  mkdirSync(dirname(path), { recursive: true });
  const conn = new Database(path);
  assertSqliteVersion(conn);
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  conn.pragma('synchronous = NORMAL');
  applyMigrations(conn);
  return conn;
}

export function setDatabase(conn: Db): void {
  db = conn;
}

export function getDatabase(): Db {
  if (!db) throw new Error('Database not initialised — call setDatabase() during app startup');
  return db;
}

export function closeDatabase(): void {
  db?.close();
  db = null;
}
