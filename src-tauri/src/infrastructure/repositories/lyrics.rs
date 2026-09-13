use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveLyricsInput {
    pub provider_lyric_id: String,
    pub raw_text: String,
    pub parsed_json: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredLyrics {
    pub track_id: String,
    pub provider: String,
    pub provider_lyric_id: String,
    pub raw_text: String,
    pub parsed_json: String,
    pub bias_ms: i64,
    pub selected_manually: bool,
}

pub struct LyricsRepository;

impl LyricsRepository {
    pub fn get(connection: &Connection, track_id: &str) -> rusqlite::Result<Option<StoredLyrics>> {
        connection.query_row(
            "SELECT track_id,provider,COALESCE(provider_lyric_id,''),raw_text,parsed_json,bias_ms,selected_manually FROM lyrics WHERE track_id=?1",
            params![track_id],
            |row| Ok(StoredLyrics { track_id: row.get(0)?, provider: row.get(1)?, provider_lyric_id: row.get(2)?, raw_text: row.get(3)?, parsed_json: row.get(4)?, bias_ms: row.get(5)?, selected_manually: row.get(6)? }),
        ).optional()
    }

    pub fn save(
        connection: &Connection,
        track_id: &str,
        lyrics: &SaveLyricsInput,
        manual: bool,
    ) -> rusqlite::Result<StoredLyrics> {
        connection.execute(
            "INSERT INTO lyrics (track_id,provider,provider_lyric_id,raw_text,parsed_json,selected_manually)
             VALUES (?1,'lrclib',?2,?3,?4,?5)
             ON CONFLICT(track_id) DO UPDATE SET provider='lrclib',provider_lyric_id=excluded.provider_lyric_id,
               raw_text=excluded.raw_text,parsed_json=excluded.parsed_json,selected_manually=excluded.selected_manually,updated_at=CURRENT_TIMESTAMP",
            params![track_id, lyrics.provider_lyric_id, lyrics.raw_text, lyrics.parsed_json, manual],
        )?;
        Self::get(connection, track_id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
    }

    pub fn set_bias(
        connection: &Connection,
        track_id: &str,
        bias_ms: i64,
    ) -> rusqlite::Result<StoredLyrics> {
        connection.execute(
            "UPDATE lyrics SET bias_ms=?2,updated_at=CURRENT_TIMESTAMP WHERE track_id=?1",
            params![track_id, bias_ms.clamp(-30_000, 30_000)],
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
    }

    #[test]
    fn saves_manual_selection_and_persists_clamped_bias() {
        let connection = database();
        let input = SaveLyricsInput {
            provider_lyric_id: "81".into(),
            raw_text: "[00:01.00]第一句".into(),
            parsed_json: r#"[{"timeMs":1000,"text":"第一句"}]"#.into(),
        };
        let stored =
            LyricsRepository::save(&connection, "bilibili:BV1test12345:42", &input, true).unwrap();
        assert!(stored.selected_manually);
        assert_eq!(stored.provider_lyric_id, "81");

        let adjusted = LyricsRepository::set_bias(&connection, &stored.track_id, 90_000).unwrap();
        assert_eq!(adjusted.bias_ms, 30_000);
        assert_eq!(
            LyricsRepository::get(&connection, &stored.track_id)
                .unwrap()
                .unwrap()
                .bias_ms,
            30_000
        );
    }
}
