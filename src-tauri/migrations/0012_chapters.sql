-- Edited chapter lists belong to the account, independently of tracks and playlists.
CREATE TABLE IF NOT EXISTS saved_chapters (
    bvid TEXT NOT NULL,
    cid INTEGER NOT NULL,
    register_json TEXT NOT NULL,
    PRIMARY KEY (bvid, cid)
);
