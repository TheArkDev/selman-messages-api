-- Folders: preachers (mog), artists (songs), prayer leaders (prayer)
CREATE TABLE IF NOT EXISTS speakers (
  id        TEXT PRIMARY KEY,           -- e.g. 'selman'
  category  TEXT NOT NULL,              -- 'mog' | 'songs' | 'prayer'
  name      TEXT NOT NULL,
  image_key TEXT,                       -- R2 key of the speaker photo
  glow      TEXT,                       -- folder outline colour, e.g. '#FFC107'
  sort      INTEGER NOT NULL DEFAULT 100
);

-- Playable items: sermons, songs, prayers
CREATE TABLE IF NOT EXISTS items (
  id           TEXT PRIMARY KEY,
  speaker_id   TEXT NOT NULL REFERENCES speakers(id),
  category     TEXT NOT NULL,
  title        TEXT NOT NULL,
  audio_key    TEXT NOT NULL,           -- R2 key of the audio file
  image_key    TEXT,                    -- optional cover; falls back to speaker photo
  duration_sec INTEGER NOT NULL DEFAULT 0,
  published_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_items_speaker  ON items(speaker_id);
CREATE INDEX IF NOT EXISTS idx_items_category ON items(category);
CREATE INDEX IF NOT EXISTS idx_speakers_cat   ON speakers(category, sort);
