//! Shared native queue resolution. Android, iOS and Harmony do not need an active WebView.
use crate::domain::source_title::{SeasonSummary, SourceTitleContext};
use crate::infrastructure::{
    database::Database,
    media_proxy::MediaProxy,
    providers::bilibili::{BilibiliProvider, VideoParts},
    repositories::library::{LibraryRepository, TrackInput},
};
use crate::interface::commands::{library_record_play, track_playback_plan};
use serde_json::{Value, json};
use tauri::Manager;

#[cfg(any(target_os = "android", test))]
pub(crate) mod lyrics;

/// Resolve playlist presentation from the canonical binding, never treat queue
/// display text as a user edit or persist it into the Bilibili source record.
fn imported_presentation(c: &rusqlite::Connection, track: &mut Value) -> Result<(), String> {
    use crate::infrastructure::repositories::imported_entries;
    let Some(entry_id) = track["importedEntry"]["entryId"]
        .as_str()
        .map(str::to_owned)
    else {
        return Ok(());
    };
    let register = imported_entries::read(c, &entry_id)?;
    let selected = imported_entries::selected(&register).filter(|entry| {
        Some(entry.playlist_id.as_str()) == track["importedEntry"]["playlistId"].as_str()
            && entry
                .track
                .as_ref()
                .is_some_and(|t| Some(t.id.as_str()) == track["id"].as_str())
    });
    let Some(entry) = selected else {
        track.as_object_mut().unwrap().remove("importedEntry");
        track
            .as_object_mut()
            .unwrap()
            .remove("importedSourceMetadata");
        return Ok(());
    };
    track["importedEntry"] = json!({"entryId":entry_id,"playlistId":entry.playlist_id,"order":entry.order,"song":entry.song,"trackId":track["id"],"mode":entry.mode,"revision":imported_entries::revision(&register)});
    if track["titleOverridden"].as_bool() == Some(true) {
        track
            .as_object_mut()
            .unwrap()
            .remove("importedSourceMetadata");
        return Ok(());
    }
    track["importedSourceMetadata"] = json!({"title":track["title"],"displayTitle":track["displayTitle"],"artist":track["artist"],"album":track["album"],"coverUrl":track["coverUrl"]});
    track["title"] = json!(entry.song.title);
    track["displayTitle"] = track["title"].clone();
    if !entry.song.artists.is_empty() {
        track["artist"] = json!(entry.song.artists.join(" / "));
    }
    if let Some(album) = entry.song.album.filter(|s| !s.is_empty()) {
        track["album"] = json!(album);
    }
    if let Some(cover) = entry.song.cover_url.filter(|s| !s.is_empty()) {
        track["coverUrl"] = json!(cover);
    }
    Ok(())
}

fn resolved_title(
    track: &Value,
    stored: &crate::infrastructure::repositories::library::TrackRecord,
) -> String {
    let chapter = stored
        .source_title_context
        .as_ref()
        .is_some_and(|c| c.season.is_some() || c.chapter_context || c.part_count > 1);
    if stored.title_overridden
        || chapter
        || queued_season(track).is_some_and(|season| season.is_legacy_catalog())
    {
        stored.title.clone()
    } else {
        track["displayTitle"]
            .as_str()
            .unwrap_or(&stored.title)
            .to_owned()
    }
}

fn queued_season(track: &Value) -> Option<SeasonSummary> {
    serde_json::from_value(track["sourceTitleContext"]["season"].clone()).ok()
}

fn input(track: &Value) -> Result<TrackInput, String> {
    let source = &track["source"];
    let metadata = if track["titleOverridden"].as_bool() != Some(true)
        && track["importedSourceMetadata"].is_object()
    {
        &track["importedSourceMetadata"]
    } else {
        track
    };
    serde_json::from_value(json!({
        "id": track["id"], "bvid": source["bvid"], "aid": source["aid"],
        "cid": source["cid"], "page": source["page"],
        "sourceTitle": track["videoTitle"].as_str().or_else(||metadata["title"].as_str()).unwrap_or_default(), "title": metadata["title"],
        "sourceTitleContext":track["sourceTitleContext"],
        "artist": metadata["artist"], "album": metadata["album"], "coverUrl": metadata["coverUrl"],
        "durationSeconds": track["durationSeconds"].as_f64().unwrap_or(0.0).round() as i64,
        "uploaderId": source["uploaderId"], "uploaderName": source["uploaderName"]
    }))
    .map_err(|_| "歌曲信息无效".into())
}

fn visibility_allowed(
    c: &rusqlite::Connection,
    payload: &Value,
    track: &Value,
) -> Result<bool, String> {
    if payload["refresh"].as_bool() == Some(true) {
        return Ok(true);
    }
    let Some(scopes) = payload["visibilityScopes"].as_array() else {
        return Ok(true);
    };
    if scopes.is_empty() {
        return Ok(true);
    }
    for scope in scopes {
        let scope = scope.as_str().ok_or("播放来源无效")?;
        if scope.is_empty()
            || crate::sync::visibility::allowed(
                c,
                track["source"]["bvid"].as_str().unwrap_or_default(),
                track["source"]["cid"].as_i64().unwrap_or_default(),
                Some(scope),
            )?
        {
            return Ok(true);
        }
    }
    Ok(false)
}
fn visibility_skip(entry_id: &str) -> Value {
    json!({"skip":true,"entryId":entry_id,"parts":[]})
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
            let season = queued_season(&track);
            let legacy_catalog = season.as_ref().is_some_and(SeasonSummary::is_legacy_catalog);
            let resolve_parts = async {
                let aid = source["aid"].as_i64().unwrap_or_default();
                if aid <= 0 {
                    return provider.video_parts(bvid).await;
                }
                let pages = provider.video_pagelist(bvid).await?;
                Ok(VideoParts {
                    access: None,
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
                    season: season.filter(|_| !legacy_catalog),
                })
            };
            if let Ok(Ok(video)) =
                tokio::time::timeout(std::time::Duration::from_secs(6), resolve_parts).await
            {
                let chapter = video.season.is_some()
                    || !legacy_catalog && track["chapterContext"].as_bool().unwrap_or(false);
                parts = video
                    .parts
                    .iter()
                    .map(|part| {
                        let context = SourceTitleContext {
                            video_title: video.title.clone(),
                            part_title: part.title.clone(),
                            part_count: video.parts.len(),
                            season: video.season.clone(),
                            chapter_context: chapter,
                        };
                        let title = context.title();
                        json!({
                            "id": format!("bilibili:{}:{}", video.bvid, part.cid),
                            "source": {"provider":"bilibili", "bvid":video.bvid, "cid":part.cid,
                                       "page":part.page, "aid":video.aid,
                                       "uploaderId":video.uploader_id, "uploaderName":video.uploader_name},
                            "title":title, "displayTitle":title,
                            "publishedAt":video.published_at,"playCount":video.play_count,
                            "chapterContext":chapter,
                            "videoTitle":video.title, "partCount":video.parts.len(),
                            "sourceTitleContext":context,
                            "coverUrl":if video.cover_url.is_empty() { &part.cover_url } else { &video.cover_url },
                            "durationSeconds":part.duration_seconds, "liked":false,
                        })
                    })
                    .collect();
                let _gate = sync.account_gate.lock().await;
                let db = app.state::<Database>();
                let c = db.0.lock().map_err(|_| "数据库正忙")?;
                if !current()
                    || profile != current_profile(app)
                    || payload["accountSession"].as_str().is_some_and(|expected| {
                        crate::infrastructure::database::account_session(&c)
                            .ok()
                            .as_deref()
                            != Some(expected)
                    })
                {
                    return Err("播放账号已变更，请重新播放".into());
                }
                let mut selected = None;
                for part in &parts {
                    if visibility_allowed(&c, &payload, part)? {
                        selected = Some(part.clone());
                        break;
                    }
                }
                if let Some(first) = selected {
                    track = first
                } else {
                    return Ok(visibility_skip(&entry_id));
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
    {
        let db = app.state::<Database>();
        let c = db.0.lock().map_err(|_| "数据库正忙")?;
        if !visibility_allowed(&c, &payload, &track)? {
            return Ok(visibility_skip(&entry_id));
        }
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
        None,
        payload["offlineOnly"].as_bool(),
    )
    .await;
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
    let plan = match plan {
        Ok(plan) => plan,
        Err(error) if error.code == "offline_unavailable" => return Ok(visibility_skip(&entry_id)),
        Err(error) => return Err(error.message),
    };
    {
        let db = app.state::<Database>();
        let c = db.0.lock().map_err(|_| "数据库正忙")?;
        if !visibility_allowed(&c, &payload, &track)? {
            return Ok(visibility_skip(&entry_id));
        }
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
    {
        let db = app.state::<Database>();
        let c = db.0.lock().map_err(|_| "数据库正忙")?;
        imported_presentation(&c, &mut track)?;
    }
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
    #[cfg(not(target_os = "android"))]
    let lyrics = {
        let db = app.state::<Database>();
        let connection = db.0.lock().map_err(|_| "数据库正忙")?;
        crate::infrastructure::repositories::lyrics::LyricsRepository::get(&connection, &stored.id)
            .ok()
            .flatten()
    };
    #[cfg(not(target_os = "android"))]
    let lyrics = lyrics.map(|stored| {
        let lines = crate::domain::lyrics::timed_lines(&stored.raw_text, &stored.parsed_json);
        let mut value = serde_json::to_value(stored).unwrap_or(Value::Null);
        value["lines"] = json!(lines);
        value
    });
    let result = json!({"url":plan.url, "upgradeUrl":plan.upgrade_url, "loudnessGainDb":plan.loudness_gain_db, "track":track, "position":position, "automaticResume":automatic_resume, "entryId":entry_id, "parts":parts});
    #[cfg(not(target_os = "android"))]
    let result = {
        let mut result = result;
        result["lyrics"] = json!(lyrics);
        result
    };
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn imported_queue_presentation_uses_canonical_binding_without_changing_recording_or_manual_edits()
     {
        use crate::infrastructure::repositories::imported_entries::{self, Change, SeedRow};
        let c = rusqlite::Connection::open_in_memory().unwrap();
        crate::infrastructure::migrations::migrate(&c).unwrap();
        let rows: Vec<SeedRow> = serde_json::from_value(json!([{"order":0,"song":{"sourceId":"qq:1","title":"呓语","artists":["毛不易"],"coverUrl":"https://music.test/album"}}])).unwrap();
        imported_entries::seed(&c, "import:test", "歌单", "qq", &rows).unwrap();
        let entry = imported_entries::list(&c, "import:test").unwrap().remove(0);
        let source: TrackInput = serde_json::from_value(json!({"id":"bilibili:BV1GJ411x7h7:1","bvid":"BV1GJ411x7h7","cid":1,"page":1,"sourceTitle":"呓语 录屏","title":"呓语 录屏","coverUrl":"https://bili.test/cover","durationSeconds":240})).unwrap();
        imported_entries::bind(
            &c,
            "import:test",
            &[Change {
                entry_id: entry.entry_id.clone(),
                expected_revision: entry.revision,
                track: source.clone(),
                mode: "automatic".into(),
            }],
        )
        .unwrap();
        let original = json!({"id":source.id,"source":{"provider":"bilibili","bvid":source.bvid,"cid":1,"page":1},"title":source.title,"coverUrl":source.cover_url,"durationSeconds":240,"importedEntry":{"entryId":entry.entry_id,"playlistId":"import:test"}});
        let mut queued = original.clone();
        imported_presentation(&c, &mut queued).unwrap();
        assert_eq!(queued["title"], "呓语");
        assert_eq!(queued["artist"], "毛不易");
        assert_eq!(queued["coverUrl"], "https://music.test/album");
        let recorded = input(&queued).unwrap();
        assert_eq!(recorded.title, source.title);
        assert_eq!(recorded.cover_url, source.cover_url);
        assert_eq!(recorded.artist, None);
        queued["titleOverridden"] = json!(true);
        queued["title"] = json!("我修改的名称");
        queued["coverUrl"] = json!("https://custom.test/cover");
        imported_presentation(&c, &mut queued).unwrap();
        assert_eq!(queued["title"], "我修改的名称");
        assert_eq!(queued["coverUrl"], "https://custom.test/cover");
        let ids = std::collections::BTreeSet::from([source.id.clone()]);
        assert_eq!(imported_entries::track_contexts(&c, &ids).unwrap().len(), 1);
        imported_entries::seed(&c, "import:other", "另一个歌单", "qq", &rows).unwrap();
        let other = imported_entries::list(&c, "import:other")
            .unwrap()
            .remove(0);
        imported_entries::bind(
            &c,
            "import:other",
            &[Change {
                entry_id: other.entry_id,
                expected_revision: other.revision,
                track: source.clone(),
                mode: "manual".into(),
            }],
        )
        .unwrap();
        assert!(
            imported_entries::track_contexts(&c, &ids)
                .unwrap()
                .is_empty()
        );
        imported_entries::remove(&c, "import:other", Some(&source.id)).unwrap();
        assert_eq!(imported_entries::track_contexts(&c, &ids).unwrap().len(), 1);
        imported_entries::remove(&c, "import:test", Some(&source.id)).unwrap();
        assert!(
            imported_entries::track_contexts(&c, &ids)
                .unwrap()
                .is_empty()
        );
        let mut removed = original;
        imported_presentation(&c, &mut removed).unwrap();
        assert!(removed.get("importedEntry").is_none());
        assert_eq!(removed["title"], source.title);
    }
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

#[cfg(test)]
mod visibility_tests {
    use super::*;
    #[test]
    fn native_background_resolver_matches_the_shared_visibility_fixture() {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        crate::infrastructure::migrations::migrate(&c).unwrap();
        let fixture: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/content-visibility.json"))
                .unwrap();
        let actor = uuid::Uuid::new_v4().to_string();
        for (index, rule) in fixture["rules"].as_array().unwrap().iter().enumerate() {
            let dot = crate::sync::causal::Dot {
                actor: actor.clone(),
                seq: index as u64 + 1,
            };
            let mut seen = crate::sync::causal::Context::default();
            seen.insert(&dot);
            let register = crate::sync::causal::Register {
                seen,
                values: vec![crate::sync::causal::Candidate {
                    dot,
                    cell: crate::sync::causal::Cell::Value(rule["hidden"].clone()),
                }],
            };
            c.execute(
                "INSERT INTO content_visibility VALUES(?1,?2,?3)",
                rusqlite::params![
                    rule["scope"].as_str().unwrap(),
                    rule["target"].as_str().unwrap(),
                    serde_json::to_string(&register).unwrap()
                ],
            )
            .unwrap();
        }
        for case in fixture["cases"].as_array().unwrap() {
            let track = json!({"source":{"bvid":case["bvid"],"cid":case["cid"]}});
            assert_eq!(
                visibility_allowed(&c, &json!({"visibilityScopes":case["scopes"]}), &track)
                    .unwrap(),
                case["allowed"].as_bool().unwrap(),
                "{case}"
            );
        }
    }
}
