-- 004 — provider response cache and the applied-operations ledger (M1b)
--
-- Deviation from PRA-M1b §5.4, recorded here rather than quietly absorbed.
-- The PRA said the persistent layer would reuse `http_cache` from migration
-- 001. Its shape does not fit: it is keyed by URL, and the design that came
-- out of the harness is keyed by idempotency key, which is deliberately NOT a
-- URL — two rows resolving to the same release must share one entry even if
-- their request URLs differ, and one URL must not serve two languages.
-- `http_cache` has never been written to (no provider has shipped), so it is
-- replaced rather than migrated.

DROP TABLE IF EXISTS http_cache;

CREATE TABLE provider_cache (
  key        TEXT PRIMARY KEY,

  -- Decomposed rather than parsed back out of the key, so a KEY_VERSION bump
  -- cannot strand rows that are still perfectly legible, and so invalidation
  -- by resource is an indexed lookup instead of a LIKE scan.
  provider   TEXT NOT NULL,
  capability TEXT NOT NULL,
  origin     TEXT NOT NULL,

  -- 'success' — the provider answered. Kept until explicitly invalidated.
  -- 'negative' — the provider is sure there is nothing. Kept with a TTL so an
  -- obscure release added later is eventually found (PRA-M1b §5.5).
  -- Transient failures are never stored: harness M-4, a failure to ask must
  -- not become a cached answer.
  outcome    TEXT NOT NULL CHECK (outcome IN ('success','negative')),

  body       TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  expires_at INTEGER
);

CREATE INDEX provider_cache_origin ON provider_cache(origin);
CREATE INDEX provider_cache_expires ON provider_cache(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX provider_cache_provider ON provider_cache(provider);

-- Per-row idempotent application (PRA-M1b §5.6).
--
-- "Idempotency per row" does not stop at the fetch. Applying a batch of
-- metadata must leave N complete rows and the rest untouched, never N
-- half-written ones — that is what makes a cancelled or crashed metadata pass
-- safe to re-run, which is what makes it resumable.
CREATE TABLE applied_ops (
  key        TEXT PRIMARY KEY,
  media_id   INTEGER REFERENCES media(id) ON DELETE CASCADE,
  applied_at INTEGER NOT NULL
);

CREATE INDEX applied_ops_media ON applied_ops(media_id);
