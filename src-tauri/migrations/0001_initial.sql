PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS source_items (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  bvid TEXT NOT NULL,
  aid INTEGER,
  cid INTEGER NOT NULL,
  page INTEGER NOT NULL DEFAULT 1,
  uploader_id INTEGER,
  uploader_name TEXT,
  source_title TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(provider, bvid, cid)
);

CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY,
  source_item_id TEXT NOT NULL UNIQUE REFERENCES source_items(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  artist TEXT,
  album TEXT,
  cover_url TEXT,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS metadata_overrides (
  track_id TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  title TEXT,
  artist TEXT,
  album TEXT,
  cover_url TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS favorites (
  track_id TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS playlists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  cover_url TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS playlist_items (
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (playlist_id, track_id)
);

CREATE TABLE IF NOT EXISTS play_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  played_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  progress_seconds REAL NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS play_history_track_time ON play_history(track_id, played_at DESC);

CREATE TABLE IF NOT EXISTS lyrics (
  track_id TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_lyric_id TEXT,
  raw_text TEXT NOT NULL,
  parsed_json TEXT NOT NULL,
  bias_ms INTEGER NOT NULL DEFAULT 0,
  selected_manually INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS search_history (
  query TEXT PRIMARY KEY,
  searched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS downloads (
  id TEXT PRIMARY KEY,
  track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  target_path TEXT NOT NULL,
  status TEXT NOT NULL,
  received_bytes INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER,
  error_message TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

PRAGMA user_version = 1;
