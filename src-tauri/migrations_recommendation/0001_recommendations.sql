-- Device-scoped recommendation data. This database is independent of the
-- Bilibili profile databases and never participates in account switching.
CREATE TABLE IF NOT EXISTS recommendation_sources (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_uid TEXT NOT NULL,
  nickname TEXT NOT NULL,
  name TEXT NOT NULL,
  name_custom INTEGER NOT NULL DEFAULT 0 CHECK (name_custom IN (0, 1)),
  sort_order INTEGER NOT NULL,
  cookie TEXT NOT NULL,
  csrf TEXT NOT NULL,
  credential_token TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  terms_accepted_at INTEGER,
  last_refresh_at INTEGER,
  last_refresh_state TEXT NOT NULL DEFAULT 'idle'
    CHECK (last_refresh_state IN ('idle', 'refreshing', 'ready', 'error', 'auth-required')),
  last_error_code TEXT,
  last_error_at INTEGER,
  retry_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (provider, provider_uid)
);
CREATE INDEX IF NOT EXISTS recommendation_sources_order
  ON recommendation_sources (sort_order, created_at, id);

CREATE TABLE IF NOT EXISTS recommendation_days (
  source_id TEXT NOT NULL REFERENCES recommendation_sources (id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  song_count INTEGER NOT NULL,
  upstream_code INTEGER,
  PRIMARY KEY (source_id, day)
);

CREATE TABLE IF NOT EXISTS recommendation_songs (
  source_id TEXT NOT NULL,
  day TEXT NOT NULL,
  position INTEGER NOT NULL,
  netease_song_id TEXT NOT NULL,
  title TEXT NOT NULL,
  artists_json TEXT NOT NULL,
  album TEXT,
  duration_seconds REAL,
  cover_url TEXT,
  match_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (match_state IN ('pending', 'matched', 'missing', 'failed')),
  track_id TEXT,
  bvid TEXT,
  cid INTEGER,
  track_json TEXT,
  match_mode TEXT CHECK (match_mode IN ('automatic', 'manual')),
  entry_revision INTEGER NOT NULL DEFAULT 0,
  match_attempts INTEGER NOT NULL DEFAULT 0,
  match_retry_at INTEGER,
  match_error_code TEXT,
  matched_at INTEGER,
  PRIMARY KEY (source_id, day, netease_song_id),
  FOREIGN KEY (source_id, day) REFERENCES recommendation_days (source_id, day) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS recommendation_songs_position
  ON recommendation_songs (source_id, day, position);
CREATE INDEX IF NOT EXISTS recommendation_songs_state
  ON recommendation_songs (source_id, day, match_state);
