use crate::domain::source_title::SourceTitleContext;
use rusqlite::{Connection, OptionalExtension};

pub fn get(c: &Connection, id: &str) -> rusqlite::Result<Option<SourceTitleContext>> {
    c.query_row("SELECT video_title,part_title,part_count,season_json,chapter_context FROM source_title_cache WHERE track_id=?1",[id],|r| {
        Ok(SourceTitleContext {video_title:r.get(0)?,part_title:r.get(1)?,part_count:r.get(2)?,
            chapter_context:r.get(4)?, season:r.get::<_,Option<String>>(3)?.and_then(|value|serde_json::from_str(&value).ok())})
    }).optional()
}
pub fn save(c: &Connection, id: &str, context: &SourceTitleContext) -> rusqlite::Result<()> {
    c.execute("INSERT INTO source_title_cache(track_id,video_title,part_title,part_count,season_json,chapter_context) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(track_id) DO UPDATE SET video_title=excluded.video_title,part_title=excluded.part_title,part_count=excluded.part_count,season_json=COALESCE(excluded.season_json,source_title_cache.season_json),chapter_context=MAX(excluded.chapter_context,source_title_cache.chapter_context)",rusqlite::params![id,context.video_title,context.part_title,context.part_count,context.season.as_ref().map(|s|serde_json::to_string(s).unwrap()),context.chapter_context])?;
    Ok(())
}
