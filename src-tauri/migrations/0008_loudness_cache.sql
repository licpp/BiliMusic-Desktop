-- Reproducible, local content measurements; never included in cloud sync.
CREATE TABLE IF NOT EXISTS loudness_cache (
    bvid TEXT NOT NULL,
    cid INTEGER NOT NULL,
    descriptor_json TEXT NOT NULL,
    accessed_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY(bvid,cid)
);
