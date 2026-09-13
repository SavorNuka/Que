/**
 * Idempotency — a cache, an in-flight map, and a key that identifies the
 * request rather than the row.
 *
 * The design and the measurements behind it are in docs/PRA-M1b.md; the
 * harness that produced them is docs/sanity-tests/idempotency.mjs. The one
 * sentence worth keeping in mind while using this module:
 *
 *   Rows that legitimately want the same resource share a key by design; rows
 *   that want different resources can never collide.
 */

export {
  DAY_MS,
  DEFAULT_POLICY,
  LayeredCache,
  MemoryCache,
  SqliteCache,
  expiryFor,
  type CacheHit,
  type CacheOutcome,
  type CachePolicy,
  type CacheWrite,
  type ProviderCache,
} from './cache';
export {
  KEY_VERSION,
  describeKey,
  idempotencyKey,
  normaliseText,
  originId,
  originSegment,
  stableStringify,
  type KeyDescriptor,
  type KeyParts,
  type OriginKind,
  type OriginRef,
} from './key';
export { SingleFlight, type RunOptions, type SingleFlightOptions } from './single-flight';
export {
  ProviderClient,
  type ClientStats,
  type ProviderClientOptions,
  type ProviderRequest,
  type ProviderResult,
  type ResultSource,
} from './request';
export {
  applyOnce,
  forgetApplied,
  forgetAppliedForMedia,
  hasApplied,
  type ApplyOnceResult,
} from './apply-once';
