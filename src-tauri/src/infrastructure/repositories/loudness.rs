use crate::domain::loudness::LoudnessDescriptor;
use rusqlite::{Connection, OptionalExtension, params};

pub struct LoudnessRepository;
impl LoudnessRepository {
    pub fn get(
        c: &Connection,
        bvid: &str,
        cid: i64,
    ) -> rusqlite::Result<Option<LoudnessDescriptor>> {
        let raw: Option<String> = c
            .query_row(
                "SELECT descriptor_json FROM loudness_cache WHERE bvid=?1 AND cid=?2",
                params![bvid, cid],
                |r| r.get(0),
            )
            .optional()?;
        let descriptor = raw
            .and_then(|v| serde_json::from_str::<LoudnessDescriptor>(&v).ok())
            .filter(|d| d.valid_for(bvid, cid));
        if descriptor.is_some() {
            c.execute(
                "UPDATE loudness_cache SET accessed_at=unixepoch() WHERE bvid=?1 AND cid=?2",
                params![bvid, cid],
            )?;
        }
        Ok(descriptor)
    }
    pub fn save(c: &Connection, descriptor: &LoudnessDescriptor) -> rusqlite::Result<()> {
        if !descriptor.valid_for(&descriptor.bvid, descriptor.cid) {
            return Ok(());
        }
        let json = serde_json::to_string(descriptor).map_err(|_| rusqlite::Error::InvalidQuery)?;
        c.execute("INSERT INTO loudness_cache(bvid,cid,descriptor_json) VALUES(?1,?2,?3) ON CONFLICT(bvid,cid) DO UPDATE SET descriptor_json=excluded.descriptor_json,accessed_at=unixepoch()",params![descriptor.bvid,descriptor.cid,json])?;
        c.execute("DELETE FROM loudness_cache WHERE rowid NOT IN (SELECT rowid FROM loudness_cache ORDER BY accessed_at DESC,rowid DESC LIMIT 2000)",[])?;
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cache_is_optional_bounded_and_isolated_by_video_part() {
        let c = Connection::open_in_memory().unwrap();
        crate::infrastructure::migrations::migrate(&c).unwrap();
        assert!(LoudnessRepository::get(&c, "BVtest", 1).unwrap().is_none());
        for cid in 1..=2001 {
            let d = LoudnessDescriptor::from_volume(
                "BVtest",
                cid,
                &serde_json::json!({"measured_i":-12.0}),
            )
            .unwrap();
            LoudnessRepository::save(&c, &d).unwrap();
        }
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM loudness_cache", [], |r| r
                .get::<_, u32>(0))
                .unwrap(),
            2000
        );
        assert!(LoudnessRepository::get(&c, "BVtest", 1).unwrap().is_none());
        assert_eq!(
            LoudnessRepository::get(&c, "BVtest", 2001)
                .unwrap()
                .unwrap()
                .gain_db(),
            -6.0
        );
        c.execute(
            "UPDATE loudness_cache SET descriptor_json='{}' WHERE cid=2001",
            [],
        )
        .unwrap();
        assert!(
            LoudnessRepository::get(&c, "BVtest", 2001)
                .unwrap()
                .is_none()
        );
    }
}
