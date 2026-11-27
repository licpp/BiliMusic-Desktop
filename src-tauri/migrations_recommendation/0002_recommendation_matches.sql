-- Cross-day reuse of Bilibili matches. A recommendation source returns the
-- same song on many days; without this table every new day matched it again.
-- Rows are device-scoped like the rest of this database and are pruned to the
-- songs that still appear in a retained day snapshot.
-- matched_at is the last time the song was still in a written day, not just the
-- first match, so the size cap evicts songs that left the list.
CREATE TABLE IF NOT EXISTS recommendation_matches (
  source_id TEXT NOT NULL REFERENCES recommendation_sources (id) ON DELETE CASCADE,
  netease_song_id TEXT NOT NULL,
  track_id TEXT NOT NULL,
  bvid TEXT NOT NULL,
  cid INTEGER,
  track_json TEXT NOT NULL,
  match_mode TEXT NOT NULL CHECK (match_mode IN ('automatic', 'manual')),
  matched_at INTEGER NOT NULL,
  PRIMARY KEY (source_id, netease_song_id)
);
CREATE INDEX IF NOT EXISTS recommendation_matches_age
  ON recommendation_matches (source_id, matched_at);
