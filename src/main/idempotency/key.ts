import { createHash } from 'node:crypto';

/**
 * Idempotency keys.
 *
 * The brief said "each row must have its own unique key, grounded with the
 * origin key". PRA-M1b §4 C4 corrects that by one level, and the correction is
 * the whole design:
 *
 *   **The key identifies the REQUEST, not the database row.**
 *
 * Both mistakes are measured in the harness (docs/sanity-tests/idempotency.mjs):
 *
 *  - Key too coarse — one key for a batch of twelve rows: 1 call, and
 *    **1 of 12 rows correct**. Eleven rows silently receive another row's data.
 *  - Key too fine — keyed on `media.id`, twelve tracks from one album make
 *    twelve identical calls for the same release and the entire deduplication
 *    win disappears. That win is 158 minutes on a 5,000-track library.
 *
 * A key grounded in the resource's own identity avoids both at once: rows that
 * legitimately want the same resource share a key by design, and rows that want
 * different resources can never collide.
 *
 *     v1:<provider>:<capability>:<origin-kind>:<origin-id>:<params-hash>
 *
 * Everything here is pure — no clock, no I/O — so it is exhaustively testable,
 * and so a normalisation change is a visible diff rather than a mystery cache
 * miss.
 */

/**
 * Bumping this invalidates every persisted entry at once (PRA-M1b R2).
 * Bump it whenever normalisation, the parameter set, or the layout changes —
 * a silent match against an entry built by different rules is worse than a
 * cold cache.
 */
export const KEY_VERSION = 'v1';

export type OriginKind = 'movie' | 'series' | 'episode' | 'release' | 'recording' | 'artist' | 'file';

/**
 * How a resource is identified.
 *
 * `id` is an external identifier that both sides agree on — an MBID, an IMDb
 * id, a TMDB id. When one exists it is the whole key, which is why two rows
 * pointing at the same release collapse to one call.
 *
 * `natural` is the fallback for a resource we have not resolved yet: the
 * fields a human would use to recognise it. It is normalised and hashed, and
 * it is strictly weaker — see PRA-M1b §12 falsification 4.
 */
export interface OriginRef {
  kind: OriginKind;
  id?: string | null;
  natural?: Record<string, string | number | null | undefined>;
}

export interface KeyParts {
  /** Which provider will answer. Two providers never share a cache entry. */
  provider: string;
  /** What is being asked for. `movie-metadata` and `movie-artwork` differ. */
  capability: string;
  origin: OriginRef;
  /**
   * Everything else that varies the response — language, format, region,
   * limit. Harness M-3: a key omitting `language` returned the English
   * subtitles for a Spanish request. The rule is mechanical: if it goes in the
   * request, it goes in here.
   */
  params?: Record<string, unknown>;
}

const DIACRITICS = /[̀-ͯ]/g;
const ARTICLES = 'the|a|an|le|la|les|el|los|las|der|die|das';
const LEADING_ARTICLE = new RegExp(`^(?:${ARTICLES})\\s+`);
const TRAILING_ARTICLE = new RegExp(`^(.*),\\s*(${ARTICLES})$`);
/** Removed, not replaced with a space: "don't" must become "dont", not "don t". */
const APOSTROPHES = /['`´ʼ‘’]/g;
const NON_ALPHANUMERIC = /[^\p{L}\p{N}]+/gu;

/**
 * Reduce text to a comparison form.
 *
 * "The Shawshank Redemption", "the shawshank redemption" and
 * "Shawshank Redemption, The" must all reach the same key or a rescan re-asks
 * for what it already knows.
 *
 * Changing this function changes every natural key it produces, which is why
 * it is pure, separately tested, and covered by KEY_VERSION.
 */
export function normaliseText(input: string): string {
  // Order matters. Apostrophes go before punctuation is turned into spaces, or
  // "don't" becomes "don t"; the trailing-article swap goes before the comma is
  // stripped, or "Redemption, The" can no longer be recognised.
  const base = input
    .normalize('NFKD')
    .replace(DIACRITICS, '')
    .toLowerCase()
    .replace(APOSTROPHES, '')
    .replace(/&/g, ' and ')
    .replace(/\s+/g, ' ')
    .trim();

  return base
    .replace(TRAILING_ARTICLE, '$2 $1')
    .replace(NON_ALPHANUMERIC, ' ')
    .trim()
    .replace(LEADING_ARTICLE, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function digest(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Serialise a value so that key order and numeric formatting cannot change the
 * hash. `{a:1,b:2}` and `{b:2,a:1}` are the same request.
 */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** The origin segment: an agreed id where we have one, a digest where we don't. */
export function originId(origin: OriginRef): string {
  const id = origin.id?.trim();
  if (id) return `id.${normaliseIdentifier(id)}`;

  if (!origin.natural || Object.keys(origin.natural).length === 0) {
    throw new Error(`Origin of kind "${origin.kind}" has neither an id nor natural fields`);
  }

  const normalised: Record<string, string | number> = {};
  for (const [field, raw] of Object.entries(origin.natural)) {
    if (raw === null || raw === undefined || raw === '') continue;
    normalised[field] = typeof raw === 'number' ? raw : normaliseText(String(raw));
  }

  if (Object.keys(normalised).length === 0) {
    throw new Error(`Origin of kind "${origin.kind}" normalised to nothing`);
  }

  return `nat.${digest(stableStringify(normalised))}`;
}

/** Ids are case-insensitive in practice (IMDb tt…, MBIDs) but not free-form. */
function normaliseIdentifier(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9._:-]/g, '');
}

/** Build the key. Pure; the same parts always give the same string. */
export function idempotencyKey(parts: KeyParts): string {
  const params = parts.params ?? {};
  const paramsHash = Object.keys(params).length === 0 ? 'none' : digest(stableStringify(params));

  return [
    KEY_VERSION,
    slug(parts.provider),
    slug(parts.capability),
    parts.origin.kind,
    originId(parts.origin),
    paramsHash,
  ].join(':');
}

function slug(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  if (cleaned === '' || cleaned === '-') throw new Error(`Key segment "${value}" is empty after cleaning`);
  return cleaned;
}

/**
 * The segment identifying one resource, independent of who is being asked or
 * what is being asked for.
 *
 * Stored as its own indexed column so a user's "re-match this item" action can
 * clear every entry for that resource in one statement (PRA-M1b R4) — the
 * Spanish subtitles along with the English ones, or the correction only half
 * applies.
 */
export function originSegment(origin: OriginRef): string {
  return `${origin.kind}:${originId(origin)}`;
}

/**
 * The key plus the fields worth storing alongside it.
 *
 * The cache keeps these decomposed rather than parsing them back out of the
 * key, so a KEY_VERSION bump cannot strand rows that are still perfectly
 * legible.
 */
export interface KeyDescriptor {
  key: string;
  provider: string;
  capability: string;
  origin: string;
}

export function describeKey(parts: KeyParts): KeyDescriptor {
  return {
    key: idempotencyKey(parts),
    provider: slug(parts.provider),
    capability: slug(parts.capability),
    origin: originSegment(parts.origin),
  };
}
