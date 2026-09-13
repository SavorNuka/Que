-- Que schema v1
-- See docs/ARCHITECTURE.md §5 (media, playlists), §12.2 (groups).
--
-- FTS note (docs/ASSUMPTIONS.md A1): media_fts declares BOTH content='' and
-- contentless_delete=1. Either one alone makes the index un-updatable, and
-- contentless columns read back as NULL — always join to media for display.
-- Requires SQLite >= 3.45.

------------------------------------------------------------------ sources

-- "One path may be designated for each media file type": UNIQUE(kind) enforces it.
CREATE TABLE sources (
  id           INTEGER PRIMARY KEY,
  kind         TEXT NOT NULL UNIQUE CHECK (kind IN ('video','audio')),
  path         TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  last_scan_at INTEGER
);

------------------------------------------------------------------ media

CREATE TABLE media (
  id             INTEGER PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('video','audio')),
  path           TEXT NOT NULL UNIQUE,
  file_name      TEXT NOT NULL,
  ext            TEXT NOT NULL,
  size_bytes     INTEGER,
  mtime_ms       INTEGER,
  quick_hash     TEXT,
  duration_ms    INTEGER,
  video_codec    TEXT,
  audio_codec    TEXT,
  container      TEXT,
  needs_remux    INTEGER NOT NULL DEFAULT 0,
  title          TEXT,
  sort_title     TEXT,
  year           INTEGER,
  overview       TEXT,
  genres         TEXT,
  trailer_yt_id  TEXT,
  user_rating    REAL,
  thumb_path     TEXT,
  thumb_source   TEXT CHECK (thumb_source IN ('tmdb','caa','itunes','embedded','frame','user')),
  provider       TEXT CHECK (provider IN ('cinemeta','tmdb','musicbrainz','itunes','manual')),
  provider_id    TEXT,
  imdb_id        TEXT,
  added_at       INTEGER NOT NULL,
  last_played_at INTEGER,
  play_count     INTEGER NOT NULL DEFAULT 0,
  resume_ms      INTEGER,
  missing        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_media_kind_sort   ON media(kind, sort_title);
CREATE INDEX idx_media_kind_year   ON media(kind, year);
CREATE INDEX idx_media_kind_rating ON media(kind, user_rating);
CREATE INDEX idx_media_kind_added  ON media(kind, added_at);
CREATE INDEX idx_media_kind_played ON media(kind, last_played_at);
CREATE INDEX idx_media_quick_hash  ON media(quick_hash);
CREATE INDEX idx_media_missing     ON media(missing) WHERE missing = 1;

CREATE TABLE audio_meta (
  media_id            INTEGER PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
  artist              TEXT,
  album_artist        TEXT,
  album               TEXT,
  track_no            INTEGER,
  disc_no             INTEGER,
  genre               TEXT,
  mb_recording_id     TEXT,
  mb_release_id       TEXT,
  mb_release_group_id TEXT
);

CREATE TABLE video_meta (
  media_id       INTEGER PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
  tagline        TEXT,
  runtime_min    INTEGER,
  content_rating TEXT,
  backdrop_path  TEXT,
  tmdb_id        INTEGER,
  is_episode     INTEGER NOT NULL DEFAULT 0,
  season         INTEGER,
  episode        INTEGER,
  series_title   TEXT
);

-- Free-form, user-authored metadata.
CREATE TABLE media_fields (
  media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  key      TEXT NOT NULL,
  value    TEXT,
  PRIMARY KEY (media_id, key)
);

CREATE TABLE media_genres (
  media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  genre    TEXT NOT NULL,
  PRIMARY KEY (media_id, genre)
);
CREATE INDEX idx_media_genres_genre ON media_genres(genre);

------------------------------------------------------------------ groups

CREATE TABLE groups (
  id           INTEGER PRIMARY KEY,
  type         TEXT NOT NULL CHECK (type IN
                 ('artist','album','series','season','saga','collection','custom')),
  kind         TEXT NOT NULL CHECK (kind IN ('video','audio')),
  parent_id    INTEGER REFERENCES groups(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  display_name TEXT,
  sort_name    TEXT,
  year         INTEGER,
  origin       TEXT NOT NULL DEFAULT 'manual'
                 CHECK (origin IN ('derived','manual','smart')),
  provider     TEXT,
  provider_id  TEXT,
  dedupe_key   TEXT,
  rule         TEXT,
  screen       TEXT,
  user_rating  REAL,
  favorite     INTEGER NOT NULL DEFAULT 0,
  deleted_at   INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_groups_dedupe ON groups(kind, type, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX idx_groups_parent ON groups(parent_id);
CREATE INDEX idx_groups_kind   ON groups(kind, type);

CREATE TABLE group_items (
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  position REAL NOT NULL,
  source   TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('derived','manual')),
  PRIMARY KEY (group_id, media_id)
);
CREATE INDEX idx_group_items_media ON group_items(media_id);
CREATE INDEX idx_group_items_pos   ON group_items(group_id, position);

CREATE TABLE group_fields (
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  key      TEXT NOT NULL,
  value    TEXT,
  PRIMARY KEY (group_id, key)
);

------------------------------------------------------------------ playlists

CREATE TABLE playlists (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('video','audio')),
  description  TEXT,
  artwork_path TEXT,
  shuffle      INTEGER NOT NULL DEFAULT 0,
  repeat       TEXT NOT NULL DEFAULT 'off' CHECK (repeat IN ('off','one','all')),
  smart_query  TEXT,
  favorite     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE playlist_items (
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  media_id    INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  position    REAL NOT NULL,
  added_at    INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, media_id)
);
CREATE INDEX idx_playlist_items_pos ON playlist_items(playlist_id, position);

------------------------------------------------------------------ caches

CREATE TABLE subtitle_cache (
  media_id   INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  language   TEXT NOT NULL,
  file_path  TEXT NOT NULL,
  source     TEXT NOT NULL,
  label      TEXT,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (media_id, language, source)
);

CREATE TABLE lyrics_cache (
  media_id   INTEGER PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  synced     INTEGER NOT NULL DEFAULT 0,
  source     TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);

CREATE TABLE http_cache (
  url        TEXT PRIMARY KEY,
  body       TEXT NOT NULL,
  status     INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL,
  expires_at INTEGER
);

------------------------------------------------------------------ skins

CREATE TABLE skins (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  author       TEXT,
  version      TEXT,
  kind         TEXT NOT NULL DEFAULT 'both' CHECK (kind IN ('video','audio','both')),
  bundled      INTEGER NOT NULL DEFAULT 0,
  favorite     INTEGER NOT NULL DEFAULT 0,
  valid        INTEGER NOT NULL DEFAULT 1,
  report       TEXT,
  preview_path TEXT,
  installed_at INTEGER NOT NULL,
  last_used_at INTEGER
);

------------------------------------------------------------------ search

-- doc_type/doc_id let one index hold both media rows and group rows (§12.5).
-- rowid is synthetic: media -> id, groups -> id + GROUP_ROWID_OFFSET.
CREATE VIRTUAL TABLE media_fts USING fts5(
  title,
  overview,
  artist,
  album,
  series_title,
  genres,
  custom,
  content='',
  contentless_delete=1,
  tokenize='porter unicode61 remove_diacritics 2'
);
