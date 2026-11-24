-- Local job checkpoints, excluded from library sync.
CREATE TABLE IF NOT EXISTS linked_batch_match_jobs (
  folder_id INTEGER PRIMARY KEY REFERENCES linked_bili_folders(folder_id) ON DELETE CASCADE,
  state_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS linked_batch_match_videos (
  folder_id INTEGER NOT NULL REFERENCES linked_batch_match_jobs(folder_id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  bvid TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(folder_id, position)
);

CREATE TABLE IF NOT EXISTS linked_batch_match_parts (
  folder_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  part_order INTEGER NOT NULL,
  track_json TEXT NOT NULL,
  PRIMARY KEY(folder_id, position, part_order),
  FOREIGN KEY(folder_id, position) REFERENCES linked_batch_match_videos(folder_id, position) ON DELETE CASCADE
);
