//! Bounded, disposable, device-local audio chunks. No signed URLs or library metadata.
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
};
pub const CHUNK_SIZE: u64 = 256 * 1024;
const DEFAULT_LIMIT: u64 = 512 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct Variant {
    pub key: String,
    pub track_id: String,
    pub bvid: String,
    pub cid: i64,
    pub quality: u32,
    pub fingerprint: String,
    pub mime: String,
    pub total: u64,
}
impl Variant {
    pub fn new(
        track_id: &str,
        bvid: &str,
        cid: i64,
        quality: u32,
        source: &super::providers::bilibili::PlaybackSource,
    ) -> Self {
        let path = reqwest::Url::parse(&source.audio_url)
            .ok()
            .map(|u| u.path().to_owned())
            .unwrap_or_default();
        let fingerprint = format!(
            "{path}|{}|{}|{}",
            source.mime_type, source.codecs, source.bandwidth
        );
        let key = format!(
            "{:x}",
            md5::compute(format!("{track_id}|{quality}|{fingerprint}"))
        );
        Self {
            key,
            track_id: track_id.into(),
            bvid: bvid.into(),
            cid,
            quality,
            fingerprint,
            mime: source.mime_type.clone(),
            total: 0,
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStatus {
    pub limit_bytes: u64,
    pub used_bytes: u64,
    pub tracks: u64,
    pub complete_tracks: u64,
}
#[derive(Serialize, Deserialize)]
struct Config {
    limit_bytes: u64,
}
pub struct PlaybackCache {
    root: PathBuf,
    config_path: PathBuf,
    connection: Mutex<Connection>,
    limit: AtomicU64,
    pub generation: AtomicU64,
}
fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}
impl PlaybackCache {
    pub fn open(root: PathBuf, config_path: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&root).map_err(|_| "无法创建播放缓存")?;
        let c = Connection::open(root.join("index.sqlite3")).map_err(|_| "无法打开播放缓存")?;
        c.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS variants(key TEXT PRIMARY KEY,track_id TEXT NOT NULL,bvid TEXT NOT NULL,cid INTEGER NOT NULL,quality INTEGER NOT NULL,fingerprint TEXT NOT NULL,mime TEXT NOT NULL,total INTEGER NOT NULL DEFAULT 0,accessed INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS variant_track ON variants(track_id,quality,accessed);
            CREATE TABLE IF NOT EXISTS chunks(variant TEXT NOT NULL REFERENCES variants(key) ON DELETE CASCADE,idx INTEGER NOT NULL,bytes INTEGER NOT NULL,accessed INTEGER NOT NULL,PRIMARY KEY(variant,idx));
            CREATE INDEX IF NOT EXISTS chunk_lru ON chunks(accessed);") .map_err(|_|"无法初始化播放缓存")?;
        let limit = std::fs::read(&config_path)
            .ok()
            .and_then(|v| serde_json::from_slice::<Config>(&v).ok())
            .map(|c| c.limit_bytes)
            .unwrap_or(DEFAULT_LIMIT)
            .min(10 * 1024 * 1024 * 1024);
        let cache = Self {
            root,
            config_path,
            connection: Mutex::new(c),
            limit: AtomicU64::new(limit),
            generation: AtomicU64::new(0),
        };
        cache.evict()?;
        Ok(cache)
    }
    pub fn enabled(&self) -> bool {
        self.limit.load(Ordering::Relaxed) > 0
    }
    pub fn total(&self, key: &str) -> Option<u64> {
        self.connection
            .lock()
            .ok()?
            .query_row("SELECT total FROM variants WHERE key=?1", [key], |r| {
                r.get(0)
            })
            .optional()
            .ok()
            .flatten()
    }
    fn path(&self, key: &str, index: u64) -> PathBuf {
        self.root.join(key).join(format!("{index}.chunk"))
    }
    pub fn find(&self, track_id: &str, quality: u32) -> Option<Variant> {
        if !self.enabled() {
            return None;
        }
        let c = self.connection.lock().ok()?;
        c.query_row("SELECT key,bvid,cid,fingerprint,mime,total FROM variants WHERE track_id=?1 AND quality=?2 AND total>0 AND EXISTS(SELECT 1 FROM chunks WHERE variant=variants.key) ORDER BY accessed DESC LIMIT 1",params![track_id,quality],|r|Ok(Variant{key:r.get(0)?,track_id:track_id.into(),bvid:r.get(1)?,cid:r.get(2)?,quality,fingerprint:r.get(3)?,mime:r.get(4)?,total:r.get(5)?})).optional().ok().flatten()
    }
    pub fn read(&self, key: &str, index: u64) -> Option<Vec<u8>> {
        let c = self.connection.lock().ok()?;
        let expected: u64 = c
            .query_row(
                "SELECT bytes FROM chunks WHERE variant=?1 AND idx=?2",
                params![key, index],
                |r| r.get(0),
            )
            .optional()
            .ok()??;
        let bytes = std::fs::read(self.path(key, index))
            .ok()
            .filter(|v| v.len() as u64 == expected);
        if bytes.is_some() {
            let _ = c.execute(
                "UPDATE chunks SET accessed=?3 WHERE variant=?1 AND idx=?2",
                params![key, index, now()],
            );
            let _ = c.execute(
                "UPDATE variants SET accessed=?2 WHERE key=?1",
                params![key, now()],
            );
        } else {
            let _ = c.execute(
                "DELETE FROM chunks WHERE variant=?1 AND idx=?2",
                params![key, index],
            );
        }
        bytes
    }
    pub fn write(
        &self,
        variant: &Variant,
        total: u64,
        index: u64,
        bytes: &[u8],
        generation: u64,
    ) -> Result<(), String> {
        if !self.enabled() || generation != self.generation.load(Ordering::Acquire) {
            return Ok(());
        }
        if total == 0
            || index.saturating_mul(CHUNK_SIZE) >= total
            || bytes.len() as u64 != CHUNK_SIZE.min(total - index * CHUNK_SIZE)
        {
            return Err("缓存片段不完整".into());
        }
        let c = self.connection.lock().map_err(|_| "缓存正忙")?;
        if generation != self.generation.load(Ordering::Acquire) {
            return Ok(());
        }
        let old: Option<u64> = c
            .query_row(
                "SELECT total FROM variants WHERE key=?1",
                [&variant.key],
                |r| r.get(0),
            )
            .optional()
            .map_err(|_| "无法读取缓存索引")?;
        if old.is_some_and(|old| old != total) {
            return Err("缓存音源已变化，请重新播放".into());
        }
        let directory = self.root.join(&variant.key);
        std::fs::create_dir_all(&directory).map_err(|_| "缓存空间不足")?;
        let path = self.path(&variant.key, index);
        let temporary = directory.join(format!("{index}.tmp"));
        std::fs::write(&temporary, bytes).map_err(|_| "缓存空间不足")?;
        std::fs::rename(&temporary, &path).map_err(|_| "无法保存播放缓存")?;
        c.execute("INSERT INTO variants(key,track_id,bvid,cid,quality,fingerprint,mime,total,accessed) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(key) DO UPDATE SET accessed=excluded.accessed",params![variant.key,variant.track_id,variant.bvid,variant.cid,variant.quality,variant.fingerprint,variant.mime,total,now()]).map_err(|_|"无法保存缓存索引")?;
        c.execute("INSERT INTO chunks(variant,idx,bytes,accessed) VALUES(?1,?2,?3,?4) ON CONFLICT(variant,idx) DO UPDATE SET bytes=excluded.bytes,accessed=excluded.accessed",params![variant.key,index,bytes.len(),now()]).map_err(|_|"无法保存缓存索引")?;
        self.evict_locked(&c)
    }
    fn evict(&self) -> Result<(), String> {
        let c = self.connection.lock().map_err(|_| "缓存正忙")?;
        self.evict_locked(&c)
    }
    fn evict_locked(&self, c: &Connection) -> Result<(), String> {
        let mut used: u64 = c
            .query_row("SELECT COALESCE(SUM(bytes),0) FROM chunks", [], |r| {
                r.get(0)
            })
            .map_err(|_| "无法读取缓存大小")?;
        let limit = self.limit.load(Ordering::Relaxed);
        while used > limit {
            // Retain container headers/tail indexes while useful body chunks remain.
            let (key,index,size):(String,u64,u64)=c.query_row("SELECT variant,idx,bytes FROM chunks JOIN variants ON variants.key=chunks.variant ORDER BY variants.accessed,CASE WHEN idx=0 OR idx=(total-1)/?1 THEN 1 ELSE 0 END,chunks.accessed LIMIT 1",[CHUNK_SIZE],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(|_|"无法清理旧缓存")?;
            match std::fs::remove_file(self.path(&key, index)) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err("无法清理旧缓存".into()),
            }
            c.execute(
                "DELETE FROM chunks WHERE variant=?1 AND idx=?2",
                params![key, index],
            )
            .map_err(|_| "无法清理缓存索引")?;
            used = used.saturating_sub(size);
        }
        let empty:Vec<String>=c.prepare("SELECT key FROM variants WHERE NOT EXISTS(SELECT 1 FROM chunks WHERE variant=variants.key)").and_then(|mut s|s.query_map([],|r|r.get(0))?.collect()).map_err(|_|"无法清理缓存索引")?;
        for key in empty {
            let _ = std::fs::remove_dir(self.root.join(&key));
            c.execute("DELETE FROM variants WHERE key=?1", [key])
                .map_err(|_| "无法清理缓存索引")?;
        }
        Ok(())
    }
    pub fn invalidate(&self, key: &str) {
        if let Ok(c) = self.connection.lock() {
            let _ = std::fs::remove_dir_all(self.root.join(key));
            let _ = c.execute("DELETE FROM variants WHERE key=?1", [key]);
        }
    }
    pub fn status(&self) -> Result<CacheStatus, String> {
        let c = self.connection.lock().map_err(|_| "缓存正忙")?;
        let used = c
            .query_row("SELECT COALESCE(SUM(bytes),0) FROM chunks", [], |r| {
                r.get(0)
            })
            .map_err(|_| "无法读取缓存大小")?;
        let tracks = c
            .query_row("SELECT COUNT(DISTINCT track_id) FROM variants", [], |r| {
                r.get(0)
            })
            .map_err(|_| "无法读取缓存索引")?;
        let complete=c.query_row("SELECT COUNT(*) FROM variants WHERE total>0 AND total=(SELECT COALESCE(SUM(bytes),0) FROM chunks WHERE variant=variants.key)",[],|r|r.get(0)).map_err(|_|"无法读取缓存索引")?;
        Ok(CacheStatus {
            limit_bytes: self.limit.load(Ordering::Relaxed),
            used_bytes: used,
            tracks,
            complete_tracks: complete,
        })
    }
    pub fn set_limit(&self, megabytes: u64) -> Result<CacheStatus, String> {
        if megabytes > 10240 {
            return Err("缓存上限不能超过 10 GB".into());
        }
        let bytes = megabytes * 1024 * 1024;
        if let Some(parent) = self.config_path.parent() {
            std::fs::create_dir_all(parent).map_err(|_| "无法保存缓存设置")?
        }
        let temporary = self.config_path.with_extension("tmp");
        std::fs::write(
            &temporary,
            serde_json::to_vec(&Config { limit_bytes: bytes }).unwrap(),
        )
        .map_err(|_| "无法保存缓存设置")?;
        std::fs::rename(&temporary, &self.config_path).map_err(|_| "无法保存缓存设置")?;
        self.limit.store(bytes, Ordering::Relaxed);
        self.evict()?;
        self.status()
    }
    pub fn clear(&self) -> Result<CacheStatus, String> {
        {
            let c = self.connection.lock().map_err(|_| "缓存正忙")?;
            self.generation.fetch_add(1, Ordering::AcqRel);
            let keys: Vec<String> = c
                .prepare("SELECT key FROM variants")
                .and_then(|mut s| s.query_map([], |r| r.get(0))?.collect())
                .map_err(|_| "无法清理缓存")?;
            for key in keys {
                std::fs::remove_dir_all(self.root.join(key))
                    .or_else(|e| {
                        if e.kind() == std::io::ErrorKind::NotFound {
                            Ok(())
                        } else {
                            Err(e)
                        }
                    })
                    .map_err(|_| "无法清理缓存文件")?;
            }
            c.execute_batch("DELETE FROM variants; PRAGMA wal_checkpoint(TRUNCATE);")
                .map_err(|_| "无法清理缓存索引")?;
        }
        self.status()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    pub(super) fn fixture() -> (PathBuf, PlaybackCache, Variant) {
        let root = std::env::temp_dir().join(format!("bilimusic-cache-{}", uuid::Uuid::new_v4()));
        let cache = PlaybackCache::open(root.join("media"), root.join("config.json")).unwrap();
        let variant = Variant::new(
            "bilibili:BVtest:42",
            "BVtest",
            42,
            0,
            &super::super::providers::bilibili::PlaybackSource {
                audio_url: "https://cdn.example/audio.m4s?token=secret".into(),
                backup_urls: vec![],
                mime_type: "audio/mp4".into(),
                codecs: "mp4a.40.2".into(),
                bandwidth: 128000,
            },
        );
        (root, cache, variant)
    }
    #[test]
    fn survives_restart_and_rejects_incomplete_or_changed_chunks() {
        let (root, cache, variant) = fixture();
        let bytes = vec![7; CHUNK_SIZE as usize];
        assert!(
            cache
                .write(&variant, CHUNK_SIZE + 8, 0, &bytes[..17], 0)
                .is_err()
        );
        assert_eq!(cache.status().unwrap().used_bytes, 0);
        cache.write(&variant, CHUNK_SIZE + 8, 0, &bytes, 0).unwrap();
        cache
            .write(&variant, CHUNK_SIZE + 8, 1, &[9; 8], 0)
            .unwrap();
        assert!(
            cache
                .write(&variant, CHUNK_SIZE + 9, 1, &[9; 9], 0)
                .is_err()
        );
        assert_eq!(cache.status().unwrap().complete_tracks, 1);
        cache.set_limit(1).unwrap();
        drop(cache);
        let cache = PlaybackCache::open(root.join("media"), root.join("config.json")).unwrap();
        assert_eq!(cache.status().unwrap().limit_bytes, 1024 * 1024);
        assert_eq!(
            cache.find(&variant.track_id, 0).unwrap().total,
            CHUNK_SIZE + 8
        );
        assert_eq!(cache.read(&variant.key, 0).unwrap(), bytes);
        assert!(cache.find(&variant.track_id, 30280).is_none());
        std::fs::remove_file(cache.path(&variant.key, 1)).unwrap();
        assert!(cache.read(&variant.key, 1).is_none());
        assert_eq!(cache.status().unwrap().used_bytes, CHUNK_SIZE);
        drop(cache);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn eviction_protects_headers_and_recent_chunks_and_clear_blocks_old_writes() {
        let (root, cache, variant) = fixture();
        cache.set_limit(1).unwrap();
        let bytes = vec![7; CHUNK_SIZE as usize];
        for index in 0..4 {
            cache
                .write(&variant, CHUNK_SIZE * 8, index, &bytes, 0)
                .unwrap();
        }
        {
            // Make the eviction order deterministic without timing-dependent sleeps.
            let c = cache.connection.lock().unwrap();
            c.execute("UPDATE chunks SET accessed=idx+1", []).unwrap();
        }
        cache.read(&variant.key, 1).unwrap();
        cache.write(&variant, CHUNK_SIZE * 8, 4, &bytes, 0).unwrap();
        assert!(cache.read(&variant.key, 0).is_some());
        assert!(cache.read(&variant.key, 1).is_some());
        assert!(cache.read(&variant.key, 2).is_none());
        assert_eq!(cache.status().unwrap().used_bytes, 1024 * 1024);
        assert_eq!(cache.clear().unwrap().used_bytes, 0);
        cache.write(&variant, CHUNK_SIZE * 8, 0, &bytes, 0).unwrap();
        assert_eq!(cache.status().unwrap().used_bytes, 0);
        cache.write(&variant, CHUNK_SIZE * 8, 0, &bytes, 1).unwrap();
        assert_eq!(cache.status().unwrap().used_bytes, CHUNK_SIZE);
        assert_eq!(cache.set_limit(0).unwrap().used_bytes, 0);
        assert!(cache.find(&variant.track_id, 0).is_none());
        drop(cache);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn signed_url_refresh_keeps_identity_but_quality_and_representation_do_not() {
        let (root, cache, variant) = fixture();
        let source = super::super::providers::bilibili::PlaybackSource {
            audio_url: "https://backup.example/audio.m4s?token=different".into(),
            backup_urls: vec![],
            mime_type: "audio/mp4".into(),
            codecs: "mp4a.40.2".into(),
            bandwidth: 128000,
        };
        assert_eq!(
            Variant::new(&variant.track_id, "BVtest", 42, 0, &source).key,
            variant.key
        );
        assert_ne!(
            Variant::new(&variant.track_id, "BVtest", 42, 30280, &source).key,
            variant.key
        );
        assert_ne!(
            Variant::new(
                &variant.track_id,
                "BVtest",
                42,
                0,
                &super::super::providers::bilibili::PlaybackSource {
                    bandwidth: 256000,
                    ..source
                }
            )
            .key,
            variant.key
        );
        drop(cache);
        std::fs::remove_dir_all(root).unwrap();
    }
}
