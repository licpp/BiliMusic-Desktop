-- Stable source-song slots; the actual playable identity remains BVID + CID.
CREATE TABLE IF NOT EXISTS imported_entries(entry_id TEXT PRIMARY KEY,playlist_id TEXT NOT NULL,register TEXT NOT NULL,local_revision INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS imported_entries_playlist ON imported_entries(playlist_id);
CREATE TABLE IF NOT EXISTS imported_entry_owned(playlist_id TEXT NOT NULL,track_id TEXT NOT NULL,PRIMARY KEY(playlist_id,track_id));
CREATE TABLE IF NOT EXISTS imported_entry_runtime(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS imported_entry_heads(target TEXT NOT NULL,actor TEXT NOT NULL,generation INTEGER NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(target,actor));
CREATE TABLE IF NOT EXISTS imported_entry_publications(target TEXT PRIMARY KEY,pending TEXT,committed TEXT);
CREATE TABLE IF NOT EXISTS imported_entry_received(target TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(target,hash));
CREATE TABLE IF NOT EXISTS imported_entry_mirror_intents(playlist_id TEXT NOT NULL,track_id TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(playlist_id,track_id));
CREATE TABLE IF NOT EXISTS imported_entry_chunk_keys(target TEXT NOT NULL,hash TEXT NOT NULL,entry_id TEXT NOT NULL,PRIMARY KEY(target,hash,entry_id));
