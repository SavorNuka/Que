import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { RestrictionSettings, RestrictionState } from '@shared/types';

/**
 * Hidden content and age limits.
 *
 * Two rules make this worth anything:
 *
 *  1. Enforcement lives in the query builder, never in the UI. The renderer
 *     cannot request hidden or over-age rows — the clause is appended by main
 *     from state the renderer does not supply. A component bug cannot leak.
 *  2. The same clause is used by the LAN server (M9). A phone on the network
 *     is a less-trusted client than the app window, not a more-trusted one.
 *
 * Unlocking is a main-process, time-limited session. The PIN is stored as a
 * scrypt hash and never crosses IPC in either direction.
 */

/** Certificate label -> minimum age. Anything unmapped is treated as unrated. */
const RATING_AGE: Record<string, number> = {
  // MPA
  G: 0, PG: 8, 'PG-13': 13, R: 17, 'NC-17': 18, X: 18,
  // US TV
  'TV-Y': 0, 'TV-Y7': 7, 'TV-G': 0, 'TV-PG': 8, 'TV-14': 14, 'TV-MA': 17,
  // BBFC
  U: 0, Uc: 0, '12': 12, '12A': 12, '15': 15, '18': 18,
  // Common numeric / other
  '0': 0, '6': 6, '7': 7, '9': 9, '10': 10, '11': 11, '13': 13, '14': 14, '16': 16,
  NR: Number.NaN, Unrated: Number.NaN, 'Not Rated': Number.NaN,
};

/** Normalise a certificate label to a minimum age, or null when unrated. */
export function ratingToAge(label: string | null | undefined): number | null {
  if (!label) return null;
  const key = label.trim();
  const direct = RATING_AGE[key] ?? RATING_AGE[key.toUpperCase()];
  if (direct === undefined) {
    const n = parseInt(key, 10);
    return Number.isFinite(n) && n >= 0 && n <= 21 ? n : null;
  }
  return Number.isNaN(direct) ? null : direct;
}

export const DEFAULT_RESTRICTIONS: RestrictionSettings = {
  enabled: false,
  maxAge: 18,
  allowUnrated: true,
  blockExplicit: false,
  pinSet: false,
  unlockMinutes: 30,
};

/**
 * State is INJECTED, not read from the settings module.
 *
 * The repository layer calls into here on every query, so if this module
 * imported settings it would drag Electron's `app` into the data layer and
 * into every test that touches a query. configure() is called once at startup
 * and again whenever settings change.
 */
let current: RestrictionSettings = DEFAULT_RESTRICTIONS;
let pin: PinRecord | null = null;
let unlockedUntil = 0;

export function configure(next: RestrictionSettings, pinRecord: PinRecord | null): void {
  current = next;
  pin = pinRecord;
  if (!next.enabled) unlockedUntil = 0;
}

export function settings(): RestrictionSettings {
  return current;
}

export function isUnlocked(): boolean {
  return Date.now() < unlockedUntil;
}

export function lock(): void {
  unlockedUntil = 0;
}

/** True when restrictions are currently being applied to queries. */
export function isActive(): boolean {
  return current.enabled && !isUnlocked();
}

// ---------------------------------------------------------------- PIN

function hashPin(pin: string, salt: Buffer): Buffer {
  return scryptSync(pin.normalize('NFKC'), salt, 32, { N: 16384, r: 8, p: 1 });
}

export function createPinRecord(pin: string): PinRecord {
  const salt = randomBytes(16);
  return { salt: salt.toString('base64'), hash: hashPin(pin, salt).toString('base64') };
}

export function verifyPin(pin: string, record: PinRecord | null): boolean {
  if (!record) return false;
  const salt = Buffer.from(record.salt, 'base64');
  const expected = Buffer.from(record.hash, 'base64');
  const actual = hashPin(pin, salt);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Returns true on success. Wrong PINs are deliberately slow (scrypt). */
export function unlock(candidate: string): boolean {
  if (!current.pinSet || pin === null) {
    // No PIN configured — unlocking is allowed but still time-limited.
    unlockedUntil = Date.now() + current.unlockMinutes * 60_000;
    return true;
  }
  if (!verifyPin(candidate, pin)) return false;
  unlockedUntil = Date.now() + current.unlockMinutes * 60_000;
  return true;
}

// ---------------------------------------------------------------- clauses

export interface RestrictionClause {
  sql: string;
  params: unknown[];
}

/**
 * Clauses ANDed into every library query, for both `media` (alias `m`) and,
 * with `alias: 'g'`, the groups listing.
 *
 * Returns [] when restrictions are off or the session is unlocked.
 */
export function mediaClauses(): RestrictionClause[] {
  if (!isActive()) return [];
  const out: RestrictionClause[] = [{ sql: 'm.hidden = 0', params: [] }];

  out.push(
    current.allowUnrated
      ? { sql: '(m.age_min IS NULL OR m.age_min <= ?)', params: [current.maxAge] }
      : { sql: '(m.age_min IS NOT NULL AND m.age_min <= ?)', params: [current.maxAge] }
  );

  if (current.blockExplicit) out.push({ sql: 'm.explicit = 0', params: [] });

  return out;
}

export function groupClauses(): RestrictionClause[] {
  if (!isActive()) return [];
  return [{ sql: 'g.hidden = 0', params: [] }];
}

/** Public view of restriction state. Never exposes the PIN record. */
export function publicState(): RestrictionState {
  return { ...current, unlocked: isUnlocked() };
}

export interface PinRecord {
  salt: string;
  hash: string;
}

export type { RestrictionSettings };
