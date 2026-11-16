-- Local public source metadata. No user choices, history or sync protocol data.
CREATE TABLE IF NOT EXISTS source_title_cache (
    track_id TEXT PRIMARY KEY,
    video_title TEXT NOT NULL,
    part_title TEXT NOT NULL,
    part_count INTEGER NOT NULL,
    season_json TEXT,
    chapter_context INTEGER NOT NULL DEFAULT 0
);
