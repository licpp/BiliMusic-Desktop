-- A season keeps one checkpoint when its entry point changes between a
-- favorite and a followed creator.
CREATE TABLE collection_progress_v13 (
  reference TEXT PRIMARY KEY,
  bvid TEXT NOT NULL, cid INTEGER NOT NULL, position_ms INTEGER NOT NULL, observed_at INTEGER NOT NULL,
  creator_ref TEXT GENERATED ALWAYS AS (
    CASE WHEN substr(reference,1,7)='season:'
      THEN 'up:' || substr(reference,8,instr(substr(reference,8),':')-1)
    END
  ) STORED
);
INSERT INTO collection_progress_v13(reference,bvid,cid,position_ms,observed_at)
SELECT reference,bvid,cid,position_ms,observed_at FROM collection_progress;
DROP TABLE collection_progress;
ALTER TABLE collection_progress_v13 RENAME TO collection_progress;
CREATE INDEX collection_progress_creator ON collection_progress(creator_ref,observed_at DESC);
