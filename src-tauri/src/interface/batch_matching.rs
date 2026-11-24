//! One automatic catalogue choice commits its metadata and lyrics together.
//! The protected state and lyric version are rechecked under the database lock;
//! asynchronous searches cannot overwrite a later manual edit or another login.
use crate::{
    infrastructure::{
        database::{Database, account_session},
        repositories::{
            library::{LibraryRepository, MetadataPatch, TrackInput, TrackRecord},
            lyrics::{LyricsRepository, SaveLyricsInput, StoredLyrics},
        },
    },
    interface::error::CommandError,
    sync::causal,
};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchSnapshot {
    session: String,
    lyric_token: Option<String>,
    protected: bool,
    track_exists: bool,
}

/// Includes the explicit override values and the full local lyric selection.
/// A network enrichment cannot trample an edit made while it was loading.
pub(super) fn pair_version(c: &Connection, track_id: &str) -> Result<String, CommandError> {
    let metadata = c.query_row(
        "SELECT title,artist,album,cover_url FROM metadata_overrides WHERE track_id=?1",
        [track_id],
        |r| {
            Ok([
                r.get::<_, Option<String>>(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
            ])
        },
    );
    let metadata = match metadata {
        Ok(value) => Some(value),
        Err(rusqlite::Error::QueryReturnedNoRows) => None,
        Err(error) => return Err(CommandError::database(error)),
    };
    let lyrics = LyricsRepository::get(c, track_id).map_err(CommandError::database)?;
    Ok(causal::hash(
        &serde_json::to_vec(&(metadata, lyrics.as_ref().map(token)))
            .expect("pair snapshot serializes"),
    ))
}

#[tauri::command]
pub fn lyric_match_version(
    database: State<'_, Database>,
    expected_account_session: String,
    track_id: String,
) -> Result<String, CommandError> {
    let c = database.0.lock().map_err(CommandError::database)?;
    super::commands::check_account_session(&c, &expected_account_session)?;
    pair_version(&c, &track_id)
}

/// This is an opaque operation token, not the provider ID. Include the local
/// alignment/content state too: bias edits intentionally keep write_token.
fn token(lyrics: &StoredLyrics) -> String {
    causal::hash(
        &serde_json::to_vec(&(
            &lyrics.write_token,
            &lyrics.provider,
            &lyrics.provider_lyric_id,
            &lyrics.raw_text,
            &lyrics.parsed_json,
            lyrics.bias_ms,
            lyrics.selected_manually,
        ))
        .expect("lyric snapshot serializes"),
    )
}
fn has_override(c: &Connection, track_id: &str) -> rusqlite::Result<bool> {
    c.query_row(
        "SELECT EXISTS(SELECT 1 FROM metadata_overrides WHERE track_id=?1)",
        [track_id],
        |r| r.get(0),
    )
}
fn protected_lyrics(lyrics: &StoredLyrics) -> bool {
    lyrics.selected_manually || lyrics.bias_ms != 0 || lyrics.provider == "local"
}
fn snapshot(
    c: &Connection,
    track_id: &str,
    allow_missing: bool,
) -> Result<MatchSnapshot, CommandError> {
    let track_exists = LibraryRepository::get(c, track_id)
        .map_err(CommandError::database)?
        .is_some();
    if !track_exists && !allow_missing {
        return Err(CommandError::validation("歌曲尚未加入资料库"));
    }
    let lyrics = LyricsRepository::get(c, track_id).map_err(CommandError::database)?;
    Ok(MatchSnapshot {
        session: account_session(c).map_err(CommandError::database)?,
        lyric_token: lyrics.as_ref().map(token),
        // Historical automatic overrides were not separately marked. Treat any
        // existing override as protected rather than guessing who authored it.
        protected: has_override(c, track_id).map_err(CommandError::database)?
            || lyrics.as_ref().is_some_and(protected_lyrics),
        track_exists,
    })
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LyricWord {
    text: String,
    start_time_ms: f64,
    end_time_ms: f64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LyricLine {
    time_ms: f64,
    text: String,
    end_time_ms: Option<f64>,
    words: Option<Vec<LyricWord>>,
    translation: Option<String>,
    romanization: Option<String>,
}
fn time_valid(t: f64) -> bool {
    t.is_finite() && (0.0..=604_800_000.0).contains(&t)
}
pub(super) fn validate(
    metadata: &MetadataPatch,
    lyrics: &SaveLyricsInput,
) -> Result<(), CommandError> {
    if metadata.title.trim().is_empty()
        || metadata.title.chars().count() > 1000
        || metadata
            .artist
            .as_ref()
            .is_some_and(|s| s.chars().count() > 1000)
        || metadata
            .album
            .as_ref()
            .is_some_and(|s| s.chars().count() > 1000)
        || metadata.cover_url.as_ref().is_some_and(|s| {
            s.len() > 4000
                || !s.trim().is_empty()
                    && url::Url::parse(s.trim())
                        .map(|url| !matches!(url.scheme(), "http" | "https"))
                        .unwrap_or(true)
        })
    {
        return Err(CommandError::validation("匹配的歌曲信息无效"));
    }
    if !["qq", "netease", "lrclib"].contains(&lyrics.provider.as_str()) {
        return Err(CommandError::validation("不支持的自动歌词来源"));
    }
    if lyrics.provider_lyric_id.len() > 128
        || lyrics
            .provider_lyric_id
            .parse::<i64>()
            .map_or(true, |id| id <= 0)
        || lyrics.raw_text.trim().is_empty()
        || lyrics.raw_text.len() > 2_000_000
        || lyrics.parsed_json.len() > 2_000_000
    {
        return Err(CommandError::validation("匹配的歌词内容无效或过大"));
    }
    let parsed: Vec<LyricLine> = serde_json::from_str(&lyrics.parsed_json)
        .map_err(|_| CommandError::validation("歌词解析数据无效"))?;
    if parsed.is_empty()
        || parsed.len() > 100_000
        || parsed.iter().any(|line| {
            !time_valid(line.time_ms)
                || line.text.len() > 16_000
                || line
                    .end_time_ms
                    .is_some_and(|t| !time_valid(t) || t < line.time_ms)
                || line.translation.as_ref().is_some_and(|s| s.len() > 16_000)
                || line.romanization.as_ref().is_some_and(|s| s.len() > 16_000)
                || line.words.as_ref().is_some_and(|words| {
                    words.len() > 10_000
                        || words.iter().any(|w| {
                            w.text.len() > 16_000
                                || !time_valid(w.start_time_ms)
                                || !time_valid(w.end_time_ms)
                                || w.end_time_ms < w.start_time_ms
                        })
                })
        })
    {
        return Err(CommandError::validation("歌词时间轴无效"));
    }
    Ok(())
}
fn commit(
    c: &Connection,
    track_id: &str,
    expected_session: &str,
    expected_lyric_token: Option<&str>,
    metadata: &MetadataPatch,
    lyrics: &SaveLyricsInput,
    new_track: Option<&TrackInput>,
) -> Result<bool, CommandError> {
    validate(metadata, lyrics)?;
    if let Some(track) = new_track {
        super::commands::validate_track(track)?;
        if track.id != track_id {
            return Err(CommandError::validation("歌曲来源标识不一致"));
        }
    }
    let tx = c.unchecked_transaction().map_err(CommandError::database)?;
    if account_session(&tx).map_err(CommandError::database)? != expected_session {
        return Ok(false);
    }
    let saved = apply_pair(
        &tx,
        track_id,
        expected_lyric_token,
        metadata,
        lyrics,
        new_track,
    )?;
    tx.commit().map_err(CommandError::database)?;
    Ok(saved)
}

/// Apply a validated catalogue/lyrics pair under the caller's checked session
/// and transaction so a linked job can commit the checkpoint with its result.
pub(super) fn apply_pair(
    c: &Connection,
    track_id: &str,
    expected_lyric_token: Option<&str>,
    metadata: &MetadataPatch,
    lyrics: &SaveLyricsInput,
    new_track: Option<&TrackInput>,
) -> Result<bool, CommandError> {
    if has_override(c, track_id).map_err(CommandError::database)? {
        return Ok(false);
    }
    let existing = LyricsRepository::get(c, track_id).map_err(CommandError::database)?;
    if existing.as_ref().is_some_and(protected_lyrics)
        || existing.as_ref().map(token).as_deref() != expected_lyric_token
    {
        return Ok(false);
    }
    if LibraryRepository::get(c, track_id)
        .map_err(CommandError::database)?
        .is_none()
    {
        let Some(track) = new_track else {
            return Ok(false);
        };
        LibraryRepository::upsert_source(c, track).map_err(CommandError::database)?;
    }
    c.execute(
        "INSERT INTO metadata_overrides(track_id,title,artist,album,cover_url) VALUES(?1,?2,?3,?4,?5)",
        params![
            track_id,
            metadata.title.trim(),
            metadata.artist.as_deref().map(str::trim),
            metadata.album.as_deref().map(str::trim),
            metadata.cover_url.as_deref().map(str::trim)
        ],
    )
    .map_err(CommandError::database)?;
    LyricsRepository::save(c, track_id, lyrics, false).map_err(CommandError::database)?;
    Ok(true)
}

pub(super) fn save_manual_pair(
    c: &Connection,
    track_id: &str,
    mut metadata: MetadataPatch,
    lyrics: &SaveLyricsInput,
) -> Result<(StoredLyrics, TrackRecord), CommandError> {
    validate(&metadata, lyrics)?;
    let tx = c.unchecked_transaction().map_err(CommandError::database)?;
    // Preserve existing overrides for fields the selected provider didn't supply.
    let previous = c.query_row(
        "SELECT artist,album,cover_url FROM metadata_overrides WHERE track_id=?1",
        [track_id],
        |r| {
            Ok((
                r.get::<_, Option<String>>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        },
    );
    match previous {
        Ok((artist, album, cover)) => {
            metadata.artist = metadata.artist.or(artist);
            metadata.album = metadata.album.or(album);
            metadata.cover_url = metadata.cover_url.or(cover);
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => {}
        Err(error) => return Err(CommandError::database(error)),
    }
    let track = LibraryRepository::update_metadata(c, track_id, &metadata)
        .map_err(CommandError::database)?;
    let lyrics =
        LyricsRepository::save(c, track_id, lyrics, true).map_err(CommandError::database)?;
    tx.commit().map_err(CommandError::database)?;
    Ok((lyrics, track))
}

#[tauri::command]
pub fn batch_match_snapshot(
    database: State<'_, Database>,
    track_id: String,
    allow_missing: Option<bool>,
) -> Result<MatchSnapshot, CommandError> {
    let c = database.0.lock().map_err(CommandError::database)?;
    snapshot(&c, &track_id, allow_missing.unwrap_or(false))
}
#[tauri::command]
pub fn batch_match_commit(
    database: State<'_, Database>,
    track_id: String,
    expected_session: String,
    expected_lyric_token: Option<String>,
    metadata: MetadataPatch,
    lyrics: SaveLyricsInput,
    new_track: Option<TrackInput>,
    job: Option<super::linked_batch_matching::MatchLease>,
) -> Result<bool, CommandError> {
    let c = database.0.lock().map_err(CommandError::database)?;
    if let Some(job) = job {
        return super::linked_batch_matching::commit(
            &c,
            &job,
            &expected_session,
            &track_id,
            expected_lyric_token.as_deref(),
            &metadata,
            &lyrics,
        );
    }
    commit(
        &c,
        &track_id,
        &expected_session,
        expected_lyric_token.as_deref(),
        &metadata,
        &lyrics,
        new_track.as_ref(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    const TRACK: &str = "bilibili:BV1GJ411x7h7:1";
    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        crate::infrastructure::migrations::migrate(&c).unwrap();
        c.execute(
            "INSERT INTO source_items(id,provider,bvid,cid) VALUES(?1,'bilibili','BV1GJ411x7h7',1)",
            [TRACK],
        )
        .unwrap();
        c.execute(
            "INSERT INTO tracks(id,source_item_id,title) VALUES(?1,?1,'原始视频标题')",
            [TRACK],
        )
        .unwrap();
        c
    }
    fn metadata() -> MetadataPatch {
        MetadataPatch {
            title: "红豆".into(),
            artist: Some("王菲".into()),
            album: Some("唱游".into()),
            cover_url: Some("https://example.com/cover.jpg".into()),
        }
    }
    fn lyrics(id: &str) -> SaveLyricsInput {
        SaveLyricsInput {
            provider: "qq".into(),
            provider_lyric_id: id.into(),
            raw_text: "[00:01]还没好好的感受".into(),
            parsed_json: r#"[{"timeMs":1000,"text":"还没好好的感受"}]"#.into(),
        }
    }
    fn apply(c: &Connection, s: &MatchSnapshot) -> Result<bool, CommandError> {
        commit(
            c,
            TRACK,
            &s.session,
            s.lyric_token.as_deref(),
            &metadata(),
            &lyrics("42"),
            None,
        )
    }
    fn unseen_track() -> TrackInput {
        TrackInput {
            id: "bilibili:BV1GJ411x7h7:2".into(),
            bvid: "BV1GJ411x7h7".into(),
            aid: None,
            cid: 2,
            page: 2,
            source_title: "第二首原视频".into(),
            source_title_context: None,
            title: "第二首原视频".into(),
            artist: None,
            album: None,
            cover_url: Some("https://example.com/source.jpg".into()),
            duration_seconds: 300,
            uploader_id: None,
            uploader_name: None,
        }
    }
    fn apply_unseen(
        c: &Connection,
        s: &MatchSnapshot,
        track: &TrackInput,
    ) -> Result<bool, CommandError> {
        commit(
            c,
            &track.id,
            &s.session,
            s.lyric_token.as_deref(),
            &metadata(),
            &lyrics("42"),
            Some(track),
        )
    }
    #[test]
    fn matching_an_unseen_part_atomically_creates_its_track_without_history_or_likes() {
        let c = db();
        let input = unseen_track();
        assert!(snapshot(&c, &input.id, false).is_err());
        let s = snapshot(&c, &input.id, true).unwrap();
        assert!(!s.track_exists);
        assert!(!s.protected);
        assert!(LibraryRepository::get(&c, &input.id).unwrap().is_none());
        assert!(apply_unseen(&c, &s, &input).unwrap());

        let track = LibraryRepository::get(&c, &input.id).unwrap().unwrap();
        let chosen = LyricsRepository::get(&c, &input.id).unwrap().unwrap();
        assert_eq!(track.cid, input.cid);
        assert_eq!(track.page, input.page);
        assert_eq!(track.title, metadata().title);
        assert_eq!(track.cover_url, metadata().cover_url);
        assert_eq!(track.source_video_title, input.source_title);
        assert_eq!(chosen.provider_lyric_id, "42");
        assert!(!chosen.selected_manually);
        assert!(snapshot(&c, &input.id, true).unwrap().track_exists);
        assert!(!apply_unseen(&c, &s, &input).unwrap());
        let history_and_likes: i64 = c
            .query_row(
                "SELECT (SELECT COUNT(*) FROM play_history) + (SELECT COUNT(*) FROM favorites)",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(history_and_likes, 0);
    }
    #[test]
    fn failing_to_save_lyrics_rolls_back_the_unseen_track_and_its_metadata() {
        let c = db();
        let input = unseen_track();
        let s = snapshot(&c, &input.id, true).unwrap();
        c.execute_batch("CREATE TRIGGER fail_batch BEFORE INSERT ON lyrics BEGIN SELECT RAISE(ABORT,'disk full'); END;")
            .unwrap();
        assert!(apply_unseen(&c, &s, &input).is_err());
        assert!(LibraryRepository::get(&c, &input.id).unwrap().is_none());
        assert!(!has_override(&c, &input.id).unwrap());
        let source_exists: bool = c
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM source_items WHERE id=?1)",
                [&input.id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!source_exists);
    }
    #[test]
    fn stale_unseen_snapshots_cannot_cross_accounts_or_override_manual_lyrics() {
        let mut c = db();
        let input = unseen_track();
        let s = snapshot(&c, &input.id, true).unwrap();
        c.execute(
            "UPDATE account_session SET token=lower(hex(randomblob(16)))",
            [],
        )
        .unwrap();
        assert!(!apply_unseen(&c, &s, &input).unwrap());
        assert!(LibraryRepository::get(&c, &input.id).unwrap().is_none());

        let s = snapshot(&c, &input.id, true).unwrap();
        LibraryRepository::upsert(&mut c, &input).unwrap();
        LyricsRepository::save(&c, &input.id, &lyrics("77"), true).unwrap();
        assert!(!apply_unseen(&c, &s, &input).unwrap());
        assert!(!has_override(&c, &input.id).unwrap());
        assert_eq!(
            LyricsRepository::get(&c, &input.id)
                .unwrap()
                .unwrap()
                .provider_lyric_id,
            "77"
        );
    }
    #[test]
    fn unseen_source_must_match_the_requested_track_id() {
        let c = db();
        let input = unseen_track();
        let s = snapshot(&c, &input.id, true).unwrap();
        let id = "bilibili:BV1GJ411x7h7:3";
        assert!(
            commit(
                &c,
                id,
                &s.session,
                None,
                &metadata(),
                &lyrics("42"),
                Some(&input)
            )
            .is_err()
        );
        assert!(LibraryRepository::get(&c, &input.id).unwrap().is_none());
        let mut invalid = input;
        invalid.cid = 3;
        assert!(apply_unseen(&c, &s, &invalid).is_err());
    }
    #[test]
    fn commits_matching_metadata_and_lyrics_atomically_without_changing_track_identity() {
        let c = db();
        let s = snapshot(&c, TRACK, false).unwrap();
        assert!(!s.protected);
        assert!(s.lyric_token.is_none());
        assert!(apply(&c, &s).unwrap());
        let track = LibraryRepository::get(&c, TRACK).unwrap().unwrap();
        let chosen = LyricsRepository::get(&c, TRACK).unwrap().unwrap();
        assert_eq!(track.title, "红豆");
        assert_eq!(track.id, TRACK);
        assert_eq!(track.cid, 1);
        assert_eq!(chosen.provider, "qq");
        assert_eq!(chosen.provider_lyric_id, "42");
        assert!(!chosen.selected_manually);
        assert!(snapshot(&c, TRACK, false).unwrap().protected);
        assert!(!apply(&c, &s).unwrap());
    }
    #[test]
    fn manual_pair_preserves_unavailable_fields_and_rejects_invalid_lyrics_without_changing_metadata()
     {
        let c = db();
        LibraryRepository::update_metadata(&c, TRACK, &metadata()).unwrap();
        let patch = MetadataPatch {
            title: "新曲名".into(),
            artist: None,
            album: None,
            cover_url: None,
        };
        let (saved, track) = save_manual_pair(&c, TRACK, patch.clone(), &lyrics("41")).unwrap();
        assert!(saved.selected_manually);
        assert_eq!(track.id, TRACK);
        assert_eq!(track.title, "新曲名");
        assert_eq!(track.cover_url, metadata().cover_url);
        let invalid = SaveLyricsInput {
            parsed_json: "[]".into(),
            ..lyrics("99")
        };
        assert!(
            save_manual_pair(
                &c,
                TRACK,
                MetadataPatch {
                    title: "不能写入".into(),
                    ..patch
                },
                &invalid
            )
            .is_err()
        );
        assert_eq!(
            LibraryRepository::get(&c, TRACK).unwrap().unwrap().title,
            "新曲名"
        );
        assert_eq!(
            LyricsRepository::get(&c, TRACK)
                .unwrap()
                .unwrap()
                .provider_lyric_id,
            "41"
        );
    }
    #[test]
    fn manual_metadata_or_lyrics_wins_a_late_automatic_result() {
        for manual_lyrics in [false, true] {
            let c = db();
            let s = snapshot(&c, TRACK, false).unwrap();
            if manual_lyrics {
                LyricsRepository::save(&c, TRACK, &lyrics("77"), true).unwrap();
            } else {
                LibraryRepository::update_metadata(
                    &c,
                    TRACK,
                    &MetadataPatch {
                        title: "用户修改".into(),
                        artist: None,
                        album: None,
                        cover_url: None,
                    },
                )
                .unwrap();
            }
            assert!(snapshot(&c, TRACK, false).unwrap().protected);
            assert!(!apply(&c, &s).unwrap());
            if manual_lyrics {
                assert_eq!(
                    LyricsRepository::get(&c, TRACK)
                        .unwrap()
                        .unwrap()
                        .provider_lyric_id,
                    "77"
                );
                assert!(!has_override(&c, TRACK).unwrap());
            } else {
                assert_eq!(
                    LibraryRepository::get(&c, TRACK).unwrap().unwrap().title,
                    "用户修改"
                );
                assert!(LyricsRepository::get(&c, TRACK).unwrap().is_none());
            }
        }
    }
    #[test]
    fn existing_bias_and_a_concurrent_bias_adjustment_are_preserved() {
        let c = db();
        LyricsRepository::save(&c, TRACK, &lyrics("77"), false).unwrap();
        let s = snapshot(&c, TRACK, false).unwrap();
        LyricsRepository::set_bias(&c, TRACK, 1200).unwrap();
        assert!(snapshot(&c, TRACK, false).unwrap().protected);
        assert!(!apply(&c, &s).unwrap());
        assert_eq!(
            LyricsRepository::get(&c, TRACK).unwrap().unwrap().bias_ms,
            1200
        );
        assert!(!has_override(&c, TRACK).unwrap());
    }
    #[test]
    fn selection_aba_and_account_aba_are_rejected() {
        let c = db();
        LyricsRepository::save(&c, TRACK, &lyrics("42"), false).unwrap();
        let s = snapshot(&c, TRACK, false).unwrap();
        LyricsRepository::save(&c, TRACK, &lyrics("77"), false).unwrap();
        LyricsRepository::save(&c, TRACK, &lyrics("42"), false).unwrap();
        assert!(!apply(&c, &s).unwrap());
        let current = snapshot(&c, TRACK, false).unwrap();
        c.execute(
            "UPDATE account_session SET token=lower(hex(randomblob(16)))",
            [],
        )
        .unwrap();
        c.execute(
            "UPDATE account_session SET token=lower(hex(randomblob(16)))",
            [],
        )
        .unwrap();
        assert!(!apply(&c, &current).unwrap());
        assert!(!has_override(&c, TRACK).unwrap());
    }
    #[test]
    fn sql_failure_after_metadata_insert_rolls_back_both_halves() {
        let c = db();
        LyricsRepository::save(&c, TRACK, &lyrics("77"), false).unwrap();
        let s = snapshot(&c, TRACK, false).unwrap();
        let before = LyricsRepository::get(&c, TRACK).unwrap().unwrap();
        c.execute_batch("CREATE TRIGGER fail_batch BEFORE UPDATE ON lyrics BEGIN SELECT RAISE(ABORT,'disk full'); END;").unwrap();
        assert!(apply(&c, &s).is_err());
        assert!(!has_override(&c, TRACK).unwrap());
        let after = LyricsRepository::get(&c, TRACK).unwrap().unwrap();
        assert_eq!(before.write_token, after.write_token);
        assert_eq!(after.provider_lyric_id, "77");
    }
    #[test]
    fn rejects_deleted_tracks_invalid_sources_and_malformed_or_oversized_payloads() {
        let c = db();
        let s = snapshot(&c, TRACK, false).unwrap();
        for provider in ["local", "bilibili", "unknown"] {
            let mut input = lyrics("42");
            input.provider = provider.into();
            assert!(commit(&c, TRACK, &s.session, None, &metadata(), &input, None).is_err());
        }
        let mut input = lyrics("42");
        input.raw_text = "x".repeat(2_000_001);
        assert!(commit(&c, TRACK, &s.session, None, &metadata(), &input, None).is_err());
        input = lyrics("42");
        input.parsed_json = "{}".into();
        assert!(commit(&c, TRACK, &s.session, None, &metadata(), &input, None).is_err());
        input.parsed_json = r#"[{"timeMs":-1,"text":"bad"}]"#.into();
        assert!(commit(&c, TRACK, &s.session, None, &metadata(), &input, None).is_err());
        let mut patch = metadata();
        patch.cover_url = Some("javascript:alert(1)".into());
        assert!(commit(&c, TRACK, &s.session, None, &patch, &lyrics("42"), None).is_err());
        c.execute("DELETE FROM tracks WHERE id=?1", [TRACK])
            .unwrap();
        assert!(!apply(&c, &s).unwrap());
        assert!(!has_override(&c, TRACK).unwrap());
        assert!(snapshot(&c, TRACK, false).is_err());
    }
}
