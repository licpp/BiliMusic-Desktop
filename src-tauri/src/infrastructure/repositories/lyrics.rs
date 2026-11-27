use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveLyricsInput {
    #[serde(default = "default_provider")]
    pub provider: String,
    pub provider_lyric_id: String,
    pub raw_text: String,
    pub parsed_json: String,
}

fn default_provider() -> String {
    "lrclib".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredLyrics {
    pub track_id: String,
    pub provider: String,
    pub provider_lyric_id: String,
    pub raw_text: String,
    pub parsed_json: String,
    pub bias_ms: i64,
    pub selected_manually: bool,
    pub write_token: String,
    pub account_session: String,
}

pub const MAX_SAFE_BIAS_MS: u64 = 9_007_199_254_740_991;

pub struct LyricsRepository;

impl LyricsRepository {
    pub fn clear_if_current(
        connection: &Connection,
        expected: &StoredLyrics,
    ) -> rusqlite::Result<Option<StoredLyrics>> {
        if super::super::database::account_session(connection)? != expected.account_session {
            return Ok(None);
        }
        // An explicit blank selection travels through the existing sync record
        // and protects the user's choice from delayed automatic matches.
        let changed = connection.execute(
            "UPDATE lyrics SET provider='local',provider_lyric_id='cleared',raw_text='',parsed_json='[]',bias_ms=0,selected_manually=1,updated_at=CURRENT_TIMESTAMP
             WHERE track_id=?1 AND write_token=?2",
            params![expected.track_id, expected.write_token],
        )?;
        if changed == 1 {
            Self::get(connection, &expected.track_id)
        } else {
            Ok(None)
        }
    }

    pub fn cached_search(
        connection: &Connection,
        key: &str,
    ) -> rusqlite::Result<Option<(String, bool)>> {
        connection.query_row("SELECT candidates_json,updated_at >= unixepoch()-86400 FROM lyric_search_cache WHERE cache_key=?1", [key], |row| Ok((row.get(0)?, row.get(1)?))).optional()
    }

    pub fn cache_search(
        connection: &Connection,
        key: &str,
        candidates: &str,
    ) -> rusqlite::Result<()> {
        connection.execute("INSERT INTO lyric_search_cache(cache_key,candidates_json) VALUES (?1,?2) ON CONFLICT(cache_key) DO UPDATE SET candidates_json=excluded.candidates_json,updated_at=unixepoch()", params![key,candidates])?;
        connection.execute("DELETE FROM lyric_search_cache WHERE cache_key NOT IN (SELECT cache_key FROM lyric_search_cache ORDER BY updated_at DESC,rowid DESC LIMIT 100)", [])?;
        Ok(())
    }

    pub fn get(connection: &Connection, track_id: &str) -> rusqlite::Result<Option<StoredLyrics>> {
        let account_session = super::super::database::account_session(connection)?;
        connection.query_row(
            "SELECT track_id,provider,COALESCE(provider_lyric_id,''),raw_text,parsed_json,bias_ms,selected_manually,write_token FROM lyrics WHERE track_id=?1",
            params![track_id],
            |row| Ok(StoredLyrics { track_id: row.get(0)?, provider: row.get(1)?, provider_lyric_id: row.get(2)?, raw_text: row.get(3)?, parsed_json: row.get(4)?, bias_ms: row.get(5)?, selected_manually: row.get(6)?, write_token: row.get(7)?, account_session: account_session.clone() }),
        ).optional()
    }

    pub fn complete(
        connection: &Connection,
        track_id: &str,
        expected: &StoredLyrics,
        raw: &str,
        parsed: &str,
    ) -> rusqlite::Result<bool> {
        if super::super::database::account_session(connection)? != expected.account_session {
            return Ok(false);
        }
        Ok(connection.execute("UPDATE lyrics SET raw_text=?5,parsed_json=?6 WHERE track_id=?1 AND provider=?2 AND COALESCE(provider_lyric_id,'')=?3 AND write_token=?4 AND raw_text=''", params![track_id,expected.provider,expected.provider_lyric_id,expected.write_token,raw,parsed])? == 1)
    }

    pub fn save(
        connection: &Connection,
        track_id: &str,
        lyrics: &SaveLyricsInput,
        manual: bool,
    ) -> rusqlite::Result<StoredLyrics> {
        connection.execute(
            "INSERT INTO lyrics (track_id,provider,provider_lyric_id,raw_text,parsed_json,selected_manually)
             VALUES (?1,?6,?2,?3,?4,?5)
             ON CONFLICT(track_id) DO UPDATE SET provider=excluded.provider,provider_lyric_id=excluded.provider_lyric_id,
               raw_text=excluded.raw_text,parsed_json=excluded.parsed_json,selected_manually=excluded.selected_manually,updated_at=CURRENT_TIMESTAMP",
            params![track_id, lyrics.provider_lyric_id, lyrics.raw_text, lyrics.parsed_json, manual, lyrics.provider],
        )?;
        Self::get(connection, track_id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
    }

    pub fn set_bias_if_current(
        connection: &Connection,
        track_id: &str,
        bias_ms: i64,
        expected: &StoredLyrics,
    ) -> rusqlite::Result<Option<StoredLyrics>> {
        if track_id != expected.track_id
            || super::super::database::account_session(connection)? != expected.account_session
        {
            return Ok(None);
        }
        let changed = connection.execute(
            "UPDATE lyrics SET bias_ms=?2,updated_at=CURRENT_TIMESTAMP WHERE track_id=?1 AND provider=?3 AND COALESCE(provider_lyric_id,'')=?4 AND write_token=?5 AND bias_ms=?6 AND raw_text=?7 AND parsed_json=?8",
            params![track_id,bias_ms,expected.provider,expected.provider_lyric_id,expected.write_token,expected.bias_ms,expected.raw_text,expected.parsed_json],
        )?;
        if changed == 1 {
            Self::get(connection, track_id)
        } else {
            Ok(None)
        }
    }

    pub fn set_bias(
        connection: &Connection,
        track_id: &str,
        bias_ms: i64,
    ) -> rusqlite::Result<StoredLyrics> {
        connection.execute(
            "UPDATE lyrics SET bias_ms=?2,updated_at=CURRENT_TIMESTAMP WHERE track_id=?1",
            params![track_id, bias_ms],
        )?;
        Self::get(connection, track_id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "PRAGMA foreign_keys=ON;
             CREATE TABLE tracks (id TEXT PRIMARY KEY);
             CREATE TABLE lyrics (
               track_id TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
               provider TEXT NOT NULL, provider_lyric_id TEXT, raw_text TEXT NOT NULL,
               parsed_json TEXT NOT NULL, bias_ms INTEGER NOT NULL DEFAULT 0,
               selected_manually INTEGER NOT NULL DEFAULT 0,
               updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
             );
             INSERT INTO tracks(id) VALUES ('bilibili:BV1test12345:42');",
            )
            .unwrap();
        connection
            .execute_batch("ALTER TABLE lyrics ADD COLUMN write_token TEXT NOT NULL DEFAULT ''; ")
            .unwrap();
        connection
            .execute_batch(include_str!("../../../migrations/0006_lyrics_guard.sql"))
            .unwrap();
        connection
    }

    #[test]
    fn synchronized_bias_rejects_a_stale_write_and_accepts_the_new_base() {
        let connection = database();
        let track_id = "bilibili:BV1test12345:42";
        let original = LyricsRepository::save(
            &connection,
            track_id,
            &SaveLyricsInput {
                provider: "netease".into(),
                provider_lyric_id: "42".into(),
                raw_text: "[00:01]歌词".into(),
                parsed_json: "[]".into(),
            },
            true,
        )
        .unwrap();
        connection
            .execute(
                "UPDATE lyrics SET bias_ms=900 WHERE track_id=?1",
                [track_id],
            )
            .unwrap();
        assert!(
            LyricsRepository::set_bias_if_current(&connection, track_id, 500, &original)
                .unwrap()
                .is_none()
        );
        let current = LyricsRepository::get(&connection, track_id)
            .unwrap()
            .unwrap();
        assert_eq!(current.write_token, original.write_token);
        assert_eq!(current.bias_ms, 900);
        let saved = LyricsRepository::set_bias_if_current(&connection, track_id, 1150, &current)
            .unwrap()
            .unwrap();
        assert_eq!(saved.bias_ms, 1150);
    }

    #[test]
    fn automatic_alignment_checks_selection_bias_content_and_account() {
        let c = database();
        let id = "bilibili:BV1test12345:42";
        let selection = SaveLyricsInput { provider: "netease".into(), provider_lyric_id: "42".into(), raw_text: "[00:01]歌词".into(), parsed_json: r#"[{"timeMs":1000,"text":"歌词","words":[{"text":"歌词","startTimeMs":1000,"endTimeMs":2000}]}]"#.into() };
        let original = LyricsRepository::save(&c, id, &selection, true).unwrap();
        let aligned = LyricsRepository::set_bias_if_current(&c, id, 2500, &original)
            .unwrap()
            .unwrap();
        assert_eq!(aligned.bias_ms, 2500);
        assert_eq!(aligned.raw_text, original.raw_text);
        assert_eq!(aligned.parsed_json, original.parsed_json);
        assert_eq!(aligned.write_token, original.write_token);
        assert!(aligned.selected_manually);
        // Another adjustment must win over an older computation.
        assert!(
            LyricsRepository::set_bias_if_current(&c, id, 3000, &original)
                .unwrap()
                .is_none()
        );
        // Switching A -> B -> A must not reuse an earlier selection token.
        let other = SaveLyricsInput {
            provider: selection.provider.clone(),
            provider_lyric_id: "43".into(),
            raw_text: selection.raw_text.clone(),
            parsed_json: selection.parsed_json.clone(),
        };
        LyricsRepository::save(&c, id, &other, true).unwrap();
        let current = LyricsRepository::save(&c, id, &selection, true).unwrap();
        assert!(
            LyricsRepository::set_bias_if_current(&c, id, 3000, &aligned)
                .unwrap()
                .is_none()
        );
        c.execute("UPDATE account_session SET token='another-login'", [])
            .unwrap();
        assert!(
            LyricsRepository::set_bias_if_current(&c, id, 3000, &current)
                .unwrap()
                .is_none()
        );
        assert_eq!(
            LyricsRepository::get(&c, id).unwrap().unwrap().bias_ms,
            2500
        );
    }

    #[test]
    fn delayed_completion_preserves_choice_bias_and_rejects_aba() {
        let c = database();
        let id = "bilibili:BV1test12345:42";
        let selection = |lyric: &str| SaveLyricsInput {
            provider: "lrclib".into(),
            provider_lyric_id: lyric.into(),
            raw_text: String::new(),
            parsed_json: "[]".into(),
        };
        let a = LyricsRepository::save(&c, id, &selection("a"), true).unwrap();
        LyricsRepository::set_bias(&c, id, 1200).unwrap();
        assert!(LyricsRepository::complete(&c, id, &a, "body", "[]").unwrap());
        assert_eq!(
            LyricsRepository::get(&c, id).unwrap().unwrap().bias_ms,
            1200
        );
        assert!(!LyricsRepository::complete(&c, id, &a, "old", "[]").unwrap());
        let a = LyricsRepository::save(&c, id, &selection("a"), true).unwrap();
        LyricsRepository::save(&c, id, &selection("b"), true).unwrap();
        LyricsRepository::save(&c, id, &selection("a"), true).unwrap();
        assert!(!LyricsRepository::complete(&c, id, &a, "old", "[]").unwrap());
        let a = LyricsRepository::get(&c, id).unwrap().unwrap();
        c.execute("DELETE FROM lyrics WHERE track_id=?1", [id])
            .unwrap();
        LyricsRepository::save(&c, id, &selection("a"), true).unwrap();
        assert!(!LyricsRepository::complete(&c, id, &a, "old", "[]").unwrap());
        let other = database();
        LyricsRepository::save(&other, id, &selection("a"), true).unwrap();
        assert!(!LyricsRepository::complete(&other, id, &a, "old", "[]").unwrap());
    }

    #[test]
    fn search_cache_survives_service_failure_and_reports_expiry() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(include_str!("../../../migrations/0001_initial.sql"))
            .unwrap();
        LyricsRepository::cache_search(&connection, "song", "[{\"id\":1}]").unwrap();
        assert_eq!(
            LyricsRepository::cached_search(&connection, "song").unwrap(),
            Some(("[{\"id\":1}]".into(), true))
        );
        connection
            .execute(
                "UPDATE lyric_search_cache SET updated_at=unixepoch()-90000",
                [],
            )
            .unwrap();
        assert_eq!(
            LyricsRepository::cached_search(&connection, "song").unwrap(),
            Some(("[{\"id\":1}]".into(), false))
        );
        assert!(
            LyricsRepository::cached_search(&connection, "other")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn clearing_resets_bias_blocks_stale_writes_and_can_be_explicitly_rematched() {
        let c = database();
        let id = "bilibili:BV1test12345:42";
        let original = SaveLyricsInput {
            provider: "qq".into(),
            provider_lyric_id: "41".into(),
            raw_text: "[00:01]歌词".into(),
            parsed_json: "[]".into(),
        };
        let saved = LyricsRepository::save(&c, id, &original, true).unwrap();
        let delayed = LyricsRepository::set_bias_if_current(&c, id, -95_000, &saved)
            .unwrap()
            .unwrap();
        assert_eq!(delayed.bias_ms, -95_000);
        let cleared = LyricsRepository::clear_if_current(&c, &delayed)
            .unwrap()
            .unwrap();
        assert_eq!(cleared.provider, "local");
        assert_eq!(cleared.provider_lyric_id, "cleared");
        assert!(cleared.raw_text.is_empty() && cleared.selected_manually);
        assert_eq!(cleared.bias_ms, 0);
        assert_ne!(cleared.write_token, saved.write_token);
        assert!(
            LyricsRepository::clear_if_current(&c, &saved)
                .unwrap()
                .is_none()
        );
        assert!(
            LyricsRepository::set_bias_if_current(&c, id, 950, &delayed)
                .unwrap()
                .is_none()
        );
        let rematched = LyricsRepository::save(&c, id, &original, true).unwrap();
        assert_eq!(rematched.bias_ms, 0);
        assert_eq!(rematched.provider_lyric_id, "41");
    }

    #[test]
    fn saves_manual_selection_and_persists_long_bias() {
        let connection = database();
        let input = SaveLyricsInput {
            provider: "lrclib".into(),
            provider_lyric_id: "81".into(),
            raw_text: "[00:01.00]第一句".into(),
            parsed_json: r#"[{"timeMs":1000,"text":"第一句"}]"#.into(),
        };
        let stored =
            LyricsRepository::save(&connection, "bilibili:BV1test12345:42", &input, true).unwrap();
        assert!(stored.selected_manually);
        assert_eq!(stored.provider_lyric_id, "81");

        let adjusted = LyricsRepository::set_bias(&connection, &stored.track_id, 90_000).unwrap();
        assert_eq!(adjusted.bias_ms, 90_000);
        assert_eq!(
            LyricsRepository::get(&connection, &stored.track_id)
                .unwrap()
                .unwrap()
                .bias_ms,
            90_000
        );
        let imported = SaveLyricsInput {
            provider: "local".into(),
            provider_lyric_id: "0".into(),
            raw_text: "user supplied lyrics".into(),
            parsed_json: "[]".into(),
        };
        let imported =
            LyricsRepository::save(&connection, &stored.track_id, &imported, true).unwrap();
        assert_eq!(imported.provider, "local");
        assert_eq!(imported.bias_ms, 90_000);
    }
}
