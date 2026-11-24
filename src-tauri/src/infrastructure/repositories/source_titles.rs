use crate::domain::source_title::SourceTitleContext;
use rusqlite::{Connection, OptionalExtension};

pub fn get(c: &Connection, id: &str) -> rusqlite::Result<Option<SourceTitleContext>> {
    c.query_row(
        "SELECT video_title,part_title,part_count,season_json,chapter_context
         FROM source_title_cache WHERE track_id=?1",
        [id],
        |row| {
            let mut context = SourceTitleContext {
                video_title: row.get(0)?,
                part_title: row.get(1)?,
                part_count: row.get(2)?,
                season: row
                    .get::<_, Option<String>>(3)?
                    .and_then(|value| serde_json::from_str(&value).ok()),
                chapter_context: row.get(4)?,
            };
            context.discard_legacy_catalog();
            Ok(context)
        },
    )
    .optional()
}

pub fn save(c: &Connection, id: &str, context: &SourceTitleContext) -> rusqlite::Result<()> {
    let season = context
        .season
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    c.execute(
        "INSERT INTO source_title_cache(track_id,video_title,part_title,part_count,season_json,chapter_context)
         VALUES(?1,?2,?3,?4,?5,?6)
         ON CONFLICT(track_id) DO UPDATE SET
           video_title=excluded.video_title,part_title=excluded.part_title,
           part_count=excluded.part_count,season_json=excluded.season_json,
           chapter_context=excluded.chapter_context",
        rusqlite::params![
            id,
            context.video_title,
            context.part_title,
            context.part_count,
            season,
            context.chapter_context
        ],
    )?;
    Ok(())
}
