//! Public Bilibili artwork cache. User metadata overrides remain separate.
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
struct Artwork {
    cover: String,
    first_frame: String,
}
fn image_key(value: &str) -> &str {
    value
        .trim()
        .trim_start_matches("https:")
        .trim_start_matches("http:")
}

pub fn canonical_cover(
    c: &Connection,
    id: &str,
    incoming: Option<&str>,
) -> rusqlite::Result<Option<String>> {
    let cached: Option<String> = c
        .query_row(
            "SELECT value FROM sync_info WHERE key=?1",
            [format!("source-artwork:{id}")],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(art) = cached.and_then(|s| serde_json::from_str::<Artwork>(&s).ok()) {
        let value = incoming.unwrap_or_default();
        if value.trim().is_empty()
            || !art.first_frame.is_empty() && image_key(value) == image_key(&art.first_frame)
        {
            return Ok(Some(art.cover));
        }
    }
    Ok(incoming.map(str::to_owned))
}

pub fn remember(
    c: &Connection,
    id: &str,
    cover: &str,
    first_frame: &str,
) -> rusqlite::Result<usize> {
    if cover.trim().is_empty() {
        return Ok(0);
    }
    let value = serde_json::to_string(&Artwork {
        cover: cover.to_owned(),
        first_frame: first_frame.to_owned(),
    })
    .unwrap();
    c.execute("INSERT INTO sync_info(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE value<>excluded.value",
        params![format!("source-artwork:{id}"),value])?;
    let old: Option<String> = c
        .query_row("SELECT cover_url FROM tracks WHERE id=?1", [id], |r| {
            r.get(0)
        })
        .optional()?
        .flatten();
    let next = canonical_cover(c, id, old.as_deref())?;
    if old == next {
        return Ok(0);
    }
    c.execute(
        "UPDATE tracks SET cover_url=?2 WHERE id=?1",
        params![id, next],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::repositories::library::{
        LibraryRepository, MetadataPatch, TrackInput,
    };
    fn input(cover: &str) -> TrackInput {
        serde_json::from_value(serde_json::json!({"id":"bilibili:BV1na4y1V7so:1108732833","bvid":"BV1na4y1V7so","cid":1108732833_i64,"page":1,"sourceTitle":"大唐创业","title":"大唐创业","coverUrl":cover,"durationSeconds":17325})).unwrap()
    }
    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        crate::infrastructure::migrations::migrate(&c).unwrap();
        c
    }
    #[test]
    fn old_first_frame_is_repaired_and_stale_playback_cannot_restore_it() {
        let mut c = db();
        let old = input("http://bili.test/first.jpg");
        LibraryRepository::upsert(&mut c, &old).unwrap();
        assert_eq!(
            remember(
                &c,
                &old.id,
                "https://bili.test/cover.jpg",
                "https://bili.test/first.jpg"
            )
            .unwrap(),
            1
        );
        for _ in 0..2 {
            assert_eq!(
                LibraryRepository::upsert(&mut c, &old)
                    .unwrap()
                    .cover_url
                    .as_deref(),
                Some("https://bili.test/cover.jpg")
            );
        }
        assert_eq!(
            remember(
                &c,
                &old.id,
                "https://bili.test/cover.jpg",
                "https://bili.test/first.jpg"
            )
            .unwrap(),
            0
        );
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM play_history", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    #[test]
    fn source_repair_preserves_user_overrides_and_unrelated_album_art() {
        let mut c = db();
        let old = input("https://bili.test/first.jpg");
        LibraryRepository::upsert(&mut c, &old).unwrap();
        LibraryRepository::update_metadata(
            &c,
            &old.id,
            &MetadataPatch {
                title: "自定义".into(),
                artist: None,
                album: None,
                cover_url: Some("https://custom.test/picture.jpg".into()),
            },
        )
        .unwrap();
        remember(
            &c,
            &old.id,
            "https://bili.test/cover.jpg",
            "https://bili.test/first.jpg",
        )
        .unwrap();
        assert_eq!(
            LibraryRepository::get(&c, &old.id)
                .unwrap()
                .unwrap()
                .cover_url
                .as_deref(),
            Some("https://custom.test/picture.jpg")
        );
        assert_eq!(
            canonical_cover(&c, &old.id, Some("https://music.test/album.jpg"))
                .unwrap()
                .as_deref(),
            Some("https://music.test/album.jpg")
        );
    }
    #[test]
    fn observing_source_artwork_never_imports_a_track_but_later_import_uses_it() {
        let mut c = db();
        let old = input("https://bili.test/first.jpg");
        assert_eq!(
            remember(
                &c,
                &old.id,
                "https://bili.test/cover.jpg",
                "https://bili.test/first.jpg"
            )
            .unwrap(),
            0
        );
        assert!(LibraryRepository::get(&c, &old.id).unwrap().is_none());
        assert_eq!(
            LibraryRepository::upsert(&mut c, &old)
                .unwrap()
                .cover_url
                .as_deref(),
            Some("https://bili.test/cover.jpg")
        );
    }
}
