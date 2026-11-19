//! Resolve the Android service timeline independently from audio startup.
use crate::domain::lyrics::timed_lines;
use crate::infrastructure::repositories::lyrics::{LyricsRepository, StoredLyrics};
use serde_json::{Value, json};

fn saved_timeline(saved: &StoredLyrics) -> Option<Value> {
    if saved.provider == "bilibili" {
        return None; // Older builds cached subtitles in the song-lyric slot.
    }
    let lines = timed_lines(&saved.raw_text, &saved.parsed_json);
    (!lines.is_empty()).then(|| timeline(lines, saved.bias_ms, false))
}

fn timeline(lines: Vec<Value>, bias_ms: i64, subtitles: bool) -> Value {
    json!({ "lines": lines, "biasMs": bias_ms, "subtitles": subtitles })
}

fn source_identity(id: &str) -> Option<(&str, i64)> {
    let (bvid, cid) = id.strip_prefix("bilibili:")?.split_once(':')?;
    let cid: i64 = cid.parse().ok()?;
    let valid_bvid = bvid.starts_with("BV")
        && bvid.len() == 12
        && bvid.bytes().all(|b| b.is_ascii_alphanumeric());
    (valid_bvid && cid > 0).then_some((bvid, cid))
}

// Provider responses use timestamped LRC. Persisted selections keep their
// parsed word timing; an uncached selection can display its lines immediately.
fn restored_lines(lrc: &str) -> Vec<Value> {
    if lrc.len() > 2_000_000 {
        return vec![];
    }
    fn stamp(mark: &str) -> Option<u64> {
        fn digits(value: &str, max: usize) -> bool {
            !value.is_empty() && value.len() <= max && value.bytes().all(|b| b.is_ascii_digit())
        }
        let (minutes, seconds) = mark.split_once(':')?;
        let (seconds, fraction) = seconds
            .split_once(['.', ':'])
            .map_or((seconds, None), |(s, f)| (s, Some(f)));
        if !digits(minutes, 3) || !digits(seconds, 2) {
            return None;
        }
        let millis = match fraction {
            Some(f) if digits(f, 3) => f.parse::<u64>().ok()? * 10_u64.pow((3 - f.len()) as u32),
            None => 0,
            _ => return None,
        };
        Some(minutes.parse::<u64>().ok()? * 60_000 + seconds.parse::<u64>().ok()? * 1_000 + millis)
    }

    let mut lines = vec![];
    for raw in lrc.lines() {
        let mut body = raw.trim();
        let mut starts = vec![];
        while let Some((mark, rest)) = body.strip_prefix('[').and_then(|s| s.split_once(']')) {
            let Some(time) = stamp(mark) else { break };
            starts.push(time);
            body = rest;
        }
        if starts.is_empty() {
            continue;
        }
        let mut text = String::new();
        while let Some((before, after)) = body.split_once('<') {
            text.push_str(before);
            if let Some((mark, rest)) = after.split_once('>') {
                if stamp(mark).is_some() {
                    body = rest;
                    continue;
                }
            }
            text.push('<');
            body = after;
        }
        text.push_str(body);
        let text = text.trim();
        if !text.is_empty() {
            lines.extend(starts.into_iter().map(|time| (time, text.to_owned())));
        }
    }
    lines.sort_by_key(|(time, _)| *time);
    lines
        .into_iter()
        .map(|(time, text)| json!({"timeMs": time, "text": text}))
        .collect()
}

fn read_selection(
    connection: &rusqlite::Connection,
    track_id: &str,
) -> Result<(String, Option<StoredLyrics>), String> {
    let session = crate::infrastructure::database::account_session(connection)
        .map_err(|error| error.to_string())?;
    let saved = LyricsRepository::get(connection, track_id).map_err(|error| error.to_string())?;
    Ok((session, saved))
}

#[cfg(target_os = "android")]
pub(crate) async fn resolve(app: &tauri::AppHandle, payload: &Value) -> Option<Value> {
    use crate::infrastructure::{
        database::Database,
        providers::{bilibili::BilibiliProvider, lrclib::LrclibProvider},
    };
    use tauri::Manager;

    let id = payload["id"].as_str()?;
    let profile = payload["profile"].as_str()?;
    let database = app.state::<Database>();
    let current_selection = || {
        let connection = database.0.lock().ok()?;
        if super::current_profile(app) != profile {
            return None;
        }
        read_selection(&connection, id).ok()
    };
    let (session, saved) = current_selection()?;
    if payload["accountSession"]
        .as_str()
        .is_some_and(|expected| expected != session)
    {
        return None;
    }
    if let Some(lyrics) = saved.as_ref().and_then(saved_timeline) {
        return Some(lyrics);
    }
    // Offline playback still uses locally available matched lyrics.
    if payload["offlineOnly"].as_bool() == Some(true) {
        return None;
    }
    let mut restored = None;
    if let Some(saved) = saved.as_ref().filter(|saved| saved.raw_text.is_empty()) {
        if let Ok(provider_id) = saved.provider_lyric_id.parse::<i64>() {
            let provider = app.state::<LrclibProvider>();
            let selected = provider
                .selected(&saved.provider, provider_id)
                .await
                .ok()
                .flatten();
            if let Some(raw) = selected.and_then(|item| item.synced_lyrics) {
                let lines = restored_lines(&raw);
                if !lines.is_empty() {
                    restored = Some(timeline(lines, saved.bias_ms, false));
                }
            }
        }
    }
    let captions = if restored.is_none() && payload["subtitles"].as_bool() == Some(true) {
        let (bvid, cid) = source_identity(id)?;
        let provider = app.state::<BilibiliProvider>();
        provider
            .default_subtitle_lines(bvid, cid)
            .await
            .ok()
            .filter(|lines| !lines.is_empty())
            .map(|lines| json!({"lines": lines, "biasMs": 0, "subtitles": true}))
    } else {
        None
    };
    let (current_session, current) = current_selection()?;
    if current_session != session {
        return None;
    }
    if let Some(lyrics) = current.as_ref().and_then(saved_timeline) {
        return Some(lyrics);
    }
    if current
        .as_ref()
        .map(|entry| (&entry.write_token, entry.bias_ms))
        != saved
            .as_ref()
            .map(|entry| (&entry.write_token, entry.bias_ms))
    {
        return None;
    }
    restored.or(captions)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_match_preserves_offset_and_words_and_ignores_old_subtitle_slot() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        crate::infrastructure::migrations::migrate(&connection).unwrap();
        let mut saved = StoredLyrics {
            track_id: "bilibili:BV1VV4y157pr:24".into(),
            provider: "qq".into(),
            provider_lyric_id: "41".into(),
            raw_text: "[00:01]一句".into(),
            parsed_json: r#"[{"timeMs":1000,"text":"一句","words":[{"startTimeMs":1000,"endTimeMs":1200,"text":"一句"}]}]"#.into(),
            bias_ms: -200,
            selected_manually: true,
            write_token: "selection".into(),
            account_session: read_selection(&connection, "absent").unwrap().0,
        };
        let frame = saved_timeline(&saved).unwrap();
        assert_eq!(frame["biasMs"], -200);
        assert_eq!(frame["lines"][0]["words"][0]["text"], "一句");
        assert_eq!(frame["subtitles"], false);
        saved.provider = "bilibili".into();
        assert!(saved_timeline(&saved).is_none());
    }

    #[test]
    fn restored_sync_lyrics_use_provider_timestamps_and_only_accept_exact_bilibili_items() {
        let frames = restored_lines(
            "[ar:标题]\n[00:02.50][00:01:125]<00:01>一句<00:02>\n[0:3]文字<3>\nplain text",
        );
        assert_eq!(
            json!(frames),
            json!([
                {"timeMs": 1125, "text": "一句"},
                {"timeMs": 2500, "text": "一句"},
                {"timeMs": 3000, "text": "文字<3>"}
            ])
        );
        assert_eq!(
            source_identity("bilibili:BV1VV4y157pr:24"),
            Some(("BV1VV4y157pr", 24))
        );
        assert_eq!(source_identity("bilibili:BV1VV4y157pr:0"), None);
        assert_eq!(source_identity("bilibili:BV1VV4y157pr:24:1"), None);
        assert_eq!(source_identity("local:24"), None);
    }
}
