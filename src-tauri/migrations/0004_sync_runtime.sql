CREATE TABLE IF NOT EXISTS sync_v2_state(target TEXT NOT NULL,key TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(target,key));
UPDATE collection_folders SET created_at=printf('1970-01-01 00:00:00.%020d',rowid) WHERE created_at IS NULL;
CREATE TRIGGER IF NOT EXISTS collection_folder_created AFTER INSERT ON collection_folders WHEN new.created_at IS NULL BEGIN
 UPDATE collection_folders SET created_at=strftime('%Y-%m-%d %H:%M:%f','now') WHERE id=new.id;
END;
