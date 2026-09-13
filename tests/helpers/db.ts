import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Db } from '../../src/main/db/connection';

const MIGRATIONS = join(process.cwd(), 'src', 'main', 'db', 'migrations');

/** Every migration, in order — the same sequence a real database goes through. */
export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/** A fully migrated in-memory database, for tests that need real SQL behaviour. */
export function freshDb(): Db {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  for (const file of migrationFiles()) {
    db.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
  }
  return db;
}
