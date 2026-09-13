-- Que schema v2 — hidden content and age limits.
--
-- Design note (ARCHITECTURE §23): these are enforced in the query builder,
-- not in the UI. The renderer cannot ask for hidden or over-age items — the
-- restriction clause is appended by main from locked state the renderer never
-- supplies. A bug in a React component must not be able to reveal anything.

ALTER TABLE media ADD COLUMN hidden   INTEGER NOT NULL DEFAULT 0;
-- Normalised minimum age (G -> 0, PG-13 -> 13, R -> 17). NULL = unrated.
ALTER TABLE media ADD COLUMN age_min  INTEGER;
-- Explicit-content flag: music tags (ITUNESADVISORY / rtng) or provider data.
ALTER TABLE media ADD COLUMN explicit INTEGER NOT NULL DEFAULT 0;

ALTER TABLE groups ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_media_hidden ON media(hidden) WHERE hidden = 1;
CREATE INDEX idx_media_age    ON media(kind, age_min);
CREATE INDEX idx_groups_hidden ON groups(hidden) WHERE hidden = 1;
