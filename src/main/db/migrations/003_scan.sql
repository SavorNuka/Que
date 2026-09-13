-- Que schema v3 — what the scanner records (M1).

-- When ffprobe last ran. NULL means never probed; a rescan skips files whose
-- size and mtime are unchanged and that already have a probe.
ALTER TABLE media ADD COLUMN probed_at INTEGER;

-- Resolution, for display ("1080p") and later for filtering.
ALTER TABLE media ADD COLUMN width  INTEGER;
ALTER TABLE media ADD COLUMN height INTEGER;

-- Why a file can't be played directly, when needs_remux = 1. One of
-- 'container' | 'video-codec' | 'audio-codec', so the UI can say something
-- specific instead of "unsupported".
ALTER TABLE media ADD COLUMN remux_reason TEXT;

-- Which source folder a row came from, so removing a source can clean up after
-- itself and a scan knows what it owns. NULL for files added by hand.
ALTER TABLE media ADD COLUMN source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL;
CREATE INDEX idx_media_source ON media(source_id);

-- Marks a file seen by the most recent scan of its source. The scan sets this
-- as it walks, then flags anything left behind as missing — one pass, no
-- second directory listing held in memory.
ALTER TABLE media ADD COLUMN seen_at INTEGER;
