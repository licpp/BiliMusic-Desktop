//! Shared native queue resolution. Android, iOS and Harmony do not need an active WebView.
use crate::infrastructure::{
    database::Database,
    media_proxy::MediaProxy,
    providers::bilibili::{BilibiliProvider, VideoParts},
    repositories::library::{LibraryRepository, TrackInput},
};
use crate::interface::commands::{library_record_play, track_playback_plan};
use serde_json::{Value, json};
use tauri::Manager;

fn resolved_title(
    track: &Value,
    stored: &crate::infrastructure::repositories::library::TrackRecord,
) -> String {
    let chapter = stored
        .source_title_context
        .as_ref()
        .is_some_and(|c| c.season.is_some() || c.chapter_context || c.part_count > 1);
    if stored.title_overridden || chapter {
        stored.title.clone()
    } else {
        track["displayTitle"]
            .as_str()
            .unwrap_or(&stored.title)
            .to_owned()
    }
}

fn input(track: &Value) -> Result<TrackInput, String> {
    let source = &track["source"];
    serde_json::from_value(json!({
        "id": track["id"], "bvid": source["bvid"], "aid": source["aid"],
        "cid": source["cid"], "page": source["page"],
        "sourceTitle": track["videoTitle"].as_str().or_else(||track["title"].as_str()).unwrap_or_default(), "title": track["title"],
        "sourceTitleContext":track["sourceTitleContext"],
        "artist": track["artist"], "album": track["album"], "coverUrl": track["coverUrl"],
        "durationSeconds": track["durationSeconds"].as_f64().unwrap_or(0.0).round() as i64,
        "uploaderId": source["uploaderId"], "uploaderName": source["uploaderName"]
    }))
    .map_err(|_| "歌曲信息无效".into())
}

pub(crate) fn current_profile(app: &tauri::AppHandle) -> String {
    std::fs::read_to_string(app.state::<Database>().1.join("active-profile")).unwrap_or_default()
}

pub(crate) async fn resolve(app: &tauri::AppHandle, payload: Value) -> Result<Value, String> {
    resolve_with_guard(app, payload, || true).await
}
pub(crate) async fn resolve_with_guard(
    app: &tauri::AppHandle,
    payload: Value,
    current: impl Fn() -> bool,
) -> Result<Value, String> {
    let fallback = current_profile(app);
    let profile = payload["profile"].as_str().unwrap_or(&fallback);
    let mut track = payload["track"].clone();
    // Check briefly under the account gate; sync network requests must not block playback.
    let sync = app.state::<crate::sync::SyncState>();
    let gate = sync.account_gate.lock().await;
    if !current()
        || profile != current_profile(app)
        || payload["accountSession"].as_str().is_some_and(|expected| {
            let db = app.state::<Database>();
            let Ok(c) = db.0.lock() else { return true };
            crate::infrastructure::database::account_session(&c)
                .ok()
                .as_deref()
                != Some(expected)
        })
    {
        return Err("播放账号已变更，请重新播放".into());
    }
    drop(gate);
    let entry_id = track["id"].as_str().unwrap_or_default().to_owned();
    let mut parts = Vec::new();
    if track["resolveParts"].as_bool() == Some(true) {
        let source = &track["source"];
        if let Some(bvid) = source["bvid"].as_str() {
            let provider = app.state::<BilibiliProvider>();
            let resolve_parts = async {
                let aid = source["aid"].as_i64().unwrap_or_default();
                if aid <= 0 {
                    return provider.video_parts(bvid).await;
                }
                let pages = provider.video_pagelist(bvid).await?;
                Ok(VideoParts {
                    play_count: None,
                    published_at: track["publishedAt"].as_u64(),
                    bvid: bvid.to_owned(),
                    aid,
                    title: track["videoTitle"]
                        .as_str()
                        .or_else(|| track["title"].as_str())
                        .unwrap_or_default()
                        .to_owned(),
                    cover_url: track["coverUrl"].as_str().unwrap_or_default().to_owned(),
                    uploader_id: source["uploaderId"].as_i64().unwrap_or_default(),
                    uploader_name: source["uploaderName"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned(),
                    parts: pages,
                    season: serde_json::from_value(track["sourceTitleContext"]["season"].clone())
                        .ok(),
                })
            };
            if let Ok(Ok(video)) =
                tokio::time::timeout(std::time::Duration::from_secs(6), resolve_parts).await
            {
                parts = video.parts.iter().map(|part| json!({
                    "id": format!("bilibili:{}:{}", video.bvid, part.cid),
                    "source": {"provider":"bilibili", "bvid":video.bvid, "cid":part.cid,
                               "page":part.page, "aid":video.aid,
                               "uploaderId":video.uploader_id, "uploaderName":video.uploader_name},
                    "title":crate::domain::source_title::source_title(&video.title,&part.title,video.parts.len(),video.season.is_some() || track["chapterContext"].as_bool().unwrap_or(false), video.season.as_ref().map(|s|s.title.as_str()).unwrap_or("")),
                    "displayTitle":crate::domain::source_title::source_title(&video.title,&part.title,video.parts.len(),video.season.is_some() || track["chapterContext"].as_bool().unwrap_or(false), video.season.as_ref().map(|s|s.title.as_str()).unwrap_or("")),
                    "publishedAt":video.published_at,"playCount":video.play_count,
                    "chapterContext":video.season.is_some() || track["chapterContext"].as_bool().unwrap_or(false),
                    "videoTitle":video.title, "partCount":video.parts.len(),
                    "sourceTitleContext":{"videoTitle":video.title,"partTitle":part.title,"partCount":video.parts.len(),"season":video.season,"chapterContext":video.season.is_some() || track["chapterContext"].as_bool().unwrap_or(false)},
                    "coverUrl":if video.cover_url.is_empty() { &part.cover_url } else { &video.cover_url },
                    "durationSeconds":part.duration_seconds, "liked":false,
                })).collect();
                if let Some(first) = parts.first() {
                    track = first.clone();
                }
            }
        }
    }
    if track["source"]["provider"] == "bilibili"
        && track["source"]["cid"].as_i64().unwrap_or_default() <= 0
    {
        return Err("无法读取合集中的这个视频".into());
    }
    let gate = sync.account_gate.lock().await;
    if !current()
        || profile != current_profile(app)
        || payload["accountSession"].as_str().is_some_and(|expected| {
            let db = app.state::<Database>();
            let Ok(c) = db.0.lock() else { return true };
            crate::infrastructure::database::account_session(&c)
                .ok()
                .as_deref()
                != Some(expected)
        })
    {
        return Err("播放账号已变更，请重新播放".into());
    }
    let refresh = payload["refresh"].as_bool() == Some(true);
    let stored = if refresh {
        let db = app.state::<Database>();
        let connection = db.0.lock().map_err(|_| "数据库正忙")?;
        LibraryRepository::get(&connection, &entry_id)
            .map_err(|_| "无法读取歌曲信息")?
            .ok_or("歌曲不存在")?
    } else {
        library_record_play(app.state::<Database>(), input(&track)?).map_err(|e| e.message)?
    };
    drop(gate);
    let plan = track_playback_plan(
        app.state::<Database>(),
        app.state::<BilibiliProvider>(),
        app.state::<MediaProxy>(),
        stored.id.clone(),
        Some(refresh),
    )
    .await
    .map_err(|e| e.message)?;
    let _gate = sync.account_gate.lock().await;
    if !current()
        || profile != current_profile(app)
        || payload["accountSession"].as_str().is_some_and(|expected| {
            let db = app.state::<Database>();
            let Ok(c) = db.0.lock() else { return true };
            crate::infrastructure::database::account_session(&c)
                .ok()
                .as_deref()
                != Some(expected)
        })
    {
        return Err("播放账号已变更，请重新播放".into());
    }
    track["title"] = json!(resolved_title(&track, &stored));
    track["videoTitle"] = json!(stored.source_video_title);
    if stored.source_title_context.is_some() {
        track["sourceTitleContext"] = json!(stored.source_title_context);
    }
    track["displayTitle"] = track["title"].clone();
    track["titleOverridden"] = json!(stored.title_overridden);
    track["artist"] = json!(stored.artist);
    track["album"] = json!(stored.album);
    track["coverUrl"] = json!(stored.cover_url);
    track["durationSeconds"] = json!(stored.duration_seconds);
    track["liked"] = json!(stored.liked);
    // Select the saved checkpoint here, but apply duration policy only after
    // AVPlayer has read this video's real media duration. No cloud read is needed.
    let explicit = payload["position"]
        .as_f64()
        .filter(|p| refresh && p.is_finite() && *p >= 0.0);
    let restart = payload["restart"].as_bool() == Some(true);
    let position = if let Some(position) = explicit {
        position
    } else if restart {
        0.0
    } else {
        let db = app.state::<Database>();
        let connection = db.0.lock().map_err(|_| "数据库正忙")?;
        LibraryRepository::playback_position(&connection, &stored.id)
            .map_err(|_| "无法读取播放进度")?
    };
    let automatic_resume = if explicit.is_some() || restart {
        Value::Null
    } else {
        json!({
            "enabled": payload["autoResume"].as_bool() != Some(false),
            "thresholdSeconds": payload["resumeThresholdSeconds"].as_f64().unwrap_or_default(),
            "collection": payload["collectionPlayback"].as_bool() == Some(true)
                || track["partCount"].as_u64().unwrap_or_default() > 1
                || track["source"]["page"].as_u64().unwrap_or_default() > 1,
            "durationSeconds": stored.duration_seconds,
        })
    };
    let lyrics = {
        let db = app.state::<Database>();
        let connection = db.0.lock().map_err(|_| "数据库正忙")?;
        crate::infrastructure::repositories::lyrics::LyricsRepository::get(&connection, &stored.id)
            .ok()
            .flatten()
    };
    let lyrics = lyrics.map(|stored| {
        let lines = crate::domain::lyrics::timed_lines(&stored.raw_text, &stored.parsed_json);
        let mut value = serde_json::to_value(stored).unwrap_or(Value::Null);
        value["lines"] = json!(lines);
        value
    });
    Ok(
        json!({"url":plan.url, "upgradeUrl":plan.upgrade_url, "track":track, "position":position, "automaticResume":automatic_resume, "entryId":entry_id, "parts":parts, "lyrics":lyrics}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn old_native_queue_titles_cannot_replace_cached_chapters_or_manual_names() {
        let mut c = rusqlite::Connection::open_in_memory().unwrap();
        crate::infrastructure::migrations::migrate(&c).unwrap();
        let input: TrackInput=serde_json::from_value(json!({"id":"bilibili:BV123:4","bvid":"BV123","cid":4,"page":1,
            "sourceTitle":"完整系列 第一章","title":"完整系列 第一章","durationSeconds":100,
            "sourceTitleContext":{"videoTitle":"完整系列 第一章","partTitle":"第一章","partCount":1,"chapterContext":true}
        })).unwrap();
        let stored = LibraryRepository::upsert(&mut c, &input).unwrap();
        let queued = json!({"displayTitle":"完整系列 第一章"});
        assert_eq!(resolved_title(&queued, &stored), "第一章");
        let edited = LibraryRepository::update_metadata(
            &c,
            &input.id,
            &crate::infrastructure::repositories::library::MetadataPatch {
                title: "我的章节".into(),
                artist: None,
                album: None,
                cover_url: None,
            },
        )
        .unwrap();
        assert_eq!(resolved_title(&queued, &edited), "我的章节");
    }

    #[test]
    fn android_and_ios_queue_tracks_use_the_same_recording_input() {
        let track = json!({"id":"bilibili:BV123:4", "title":"第二部分", "durationSeconds":125.4,
            "source":{"bvid":"BV123","aid":1,"cid":4,"page":2},"coverUrl":"https://example.com/cover.jpg"});
        let input = input(&track).unwrap();
        assert_eq!(input.id, "bilibili:BV123:4");
        assert_eq!(input.cid, 4);
        assert_eq!(input.page, 2);
        assert_eq!(input.title, "第二部分");
        assert_eq!(input.duration_seconds, 125);
        assert!(super::input(&json!({"id":"broken"})).is_err());
    }
}
