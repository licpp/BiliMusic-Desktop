//! Local source metadata cache; never part of personal sync or listening totals.
use crate::infrastructure::{
    database::{Database, account_session},
    providers::bilibili::{
        BilibiliProvider, ProviderError, RequestPriority, VideoPart, VideoParts,
    },
};
use rusqlite::{Connection, params};
use std::{collections::BTreeSet, future::Future, sync::Mutex};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub(super) struct Hydration {
    gate: tokio::sync::Mutex<()>,
    generation: Mutex<CancellationToken>,
}

impl Hydration {
    pub(super) fn cancel(&self) {
        if let Ok(mut generation) = self.generation.lock() {
            std::mem::take(&mut *generation).cancel();
        }
    }

    pub(super) async fn run(
        &self,
        database: &Database,
        expected_session: &str,
        work: impl Future<Output = Result<usize, String>>,
    ) -> Result<usize, String> {
        let generation = self.generation.lock().map_err(|_| "资料补全正忙")?.clone();
        tokio::select! {
            biased;
            _ = generation.cancelled() => Ok(0),
            result = async {
                let _gate = self.gate.lock().await;
                {
                    let c = database.0.lock().map_err(|_| "数据库正忙")?;
                    if !matches_session(&c, expected_session)? {
                        return Ok(0);
                    }
                }
                work.await
            } => result,
        }
    }
}

fn matches_session(c: &Connection, expected_session: &str) -> Result<bool, String> {
    account_session(c)
        .map(|session| session == expected_session)
        .map_err(|e| e.to_string())
}

fn display_title(video: &VideoParts, part: &VideoPart) -> String {
    crate::domain::source_title::source_title(
        &video.title,
        &part.title,
        video.parts.len(),
        video.season.is_some(),
        video
            .season
            .as_ref()
            .map(|s| s.title.as_str())
            .unwrap_or(""),
    )
}

pub(crate) fn save(c: &rusqlite::Connection, video: &VideoParts) -> Result<usize, String> {
    let tx = c.unchecked_transaction().map_err(|e| e.to_string())?;
    let mut changed = c.execute("INSERT INTO sync_info(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE value<>excluded.value",params![format!("source-published:{}",video.bvid),video.published_at.unwrap_or(0).to_string()]).map_err(|e|e.to_string())?;
    if let Some(count) = video.play_count {
        changed += c.execute("INSERT INTO sync_info(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE value<>excluded.value", params![format!("source-plays:{}",video.bvid),count.to_string()]).map_err(|e|e.to_string())?;
    }
    for part in &video.parts {
        let id = format!("bilibili:{}:{}", video.bvid, part.cid);
        if part.duration_seconds > 0 {
            changed += c
                .execute(
                    "UPDATE tracks SET duration_seconds=?2 WHERE id=?1 AND duration_seconds<=0",
                    params![id, part.duration_seconds],
                )
                .map_err(|error| error.to_string())?;
        }
        changed += crate::infrastructure::repositories::source_artwork::remember(
            c,
            &id,
            if video.cover_url.is_empty() {
                &part.cover_url
            } else {
                &video.cover_url
            },
            &part.first_frame_url,
        )
        .map_err(|e| e.to_string())?;
        let previous = crate::infrastructure::repositories::source_titles::get(c, &id)
            .map_err(|e| e.to_string())?;
        let mut context = crate::domain::source_title::SourceTitleContext {
            video_title: video.title.clone(),
            part_title: part.title.clone(),
            part_count: video.parts.len(),
            season: video.season.clone(),
            chapter_context: video.season.is_some(),
        };
        context.preserve_membership(previous.as_ref());
        let title = context.title();
        changed += c
            .execute(
                "UPDATE tracks SET title=?2 WHERE id=?1 AND title<>?2",
                params![id, title],
            )
            .map_err(|e| e.to_string())?;
        crate::infrastructure::repositories::source_titles::save(c, &id, &context)
            .map_err(|e| e.to_string())?;
        c.execute(
            "UPDATE source_items SET source_title=?2 WHERE id=?1",
            params![id, video.title],
        )
        .map_err(|e| e.to_string())?;
        let key = format!("source-title:{id}");
        changed += c.execute("INSERT INTO sync_info(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE value<>excluded.value", params![key,title]).map_err(|e|e.to_string())?;
    }
    c.execute("INSERT INTO sync_info(key,value) VALUES(?1,strftime('%s','now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [format!("source-title-chapter-v3-checked:{}",video.bvid)]).map_err(|e|e.to_string())?;
    if !video.cover_url.is_empty() {
        c.execute("INSERT INTO sync_info(key,value) VALUES(?1,'1') ON CONFLICT(key) DO UPDATE SET value='1'",[format!("source-artwork-v1-checked:{}",video.bvid)]).map_err(|e|e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(changed)
}

// Older cache entries lack canonical artwork and need one public metadata refresh.
fn cache_is_fresh(c: &rusqlite::Connection, bvid: &str) -> bool {
    c.query_row(
        "SELECT CAST(value AS INTEGER)>CAST(strftime('%s','now') AS INTEGER)-604800
         FROM sync_info WHERE key=?1
         AND EXISTS(SELECT 1 FROM sync_info WHERE key='source-published:'||?2)
         AND EXISTS(SELECT 1 FROM sync_info WHERE key='source-plays:'||?2)
         AND EXISTS(SELECT 1 FROM sync_info WHERE key='source-artwork-v1-checked:'||?2 AND value='1')
         AND NOT EXISTS(SELECT 1 FROM tracks t JOIN source_items s ON s.id=t.source_item_id
           WHERE s.bvid=?2 AND t.duration_seconds<=0)",
        params![format!("source-title-chapter-v3-checked:{bvid}"), bvid],
        |r| r.get::<_, bool>(0),
    ).unwrap_or(false)
}

pub(super) async fn hydrate_titles(
    database: &Database,
    provider: &BilibiliProvider,
    expected_session: &str,
    ids: Vec<String>,
) -> Result<usize, String> {
    let videos = ids
        .into_iter()
        .take(8)
        .filter_map(|id| {
            let mut parts = id.split(':');
            if parts.next()? != "bilibili" {
                return None;
            }
            let bvid = parts.next()?;
            parts.next()?.parse::<i64>().ok()?;
            if parts.next().is_some() || !bvid.starts_with("BV") || bvid.len() != 12 {
                return None;
            }
            Some(bvid.to_owned())
        })
        .collect::<BTreeSet<_>>();
    let mut changed = 0;
    for bvid in videos {
        let fresh = {
            let c = database.0.lock().map_err(|_| "数据库正忙")?;
            if !matches_session(&c, expected_session)? {
                return Ok(0);
            }
            cache_is_fresh(&c, &bvid)
        };
        if fresh {
            continue;
        }
        match provider
            .video_parts_with_priority(&bvid, RequestPriority::Background)
            .await
        {
            Ok(video) => {
                let Some(count) = save_for_session(database, expected_session, &video, save)?
                else {
                    return Ok(0);
                };
                changed += count;
            }
            Err(error)
                if error.is_request_restricted()
                    || matches!(
                        error,
                        ProviderError::AccountChanged | ProviderError::NotAuthenticated
                    ) =>
            {
                break;
            }
            Err(_) => continue,
        }
    }
    Ok(changed)
}

fn save_for_session(
    database: &Database,
    expected_session: &str,
    video: &VideoParts,
    save: impl FnOnce(&Connection, &VideoParts) -> Result<usize, String>,
) -> Result<Option<usize>, String> {
    let c = database.0.lock().map_err(|_| "数据库正忙")?;
    if !matches_session(&c, expected_session)? {
        return Ok(None);
    }
    save(&c, video).map(Some)
}

fn save_placeholders(c: &Connection, video: &VideoParts) -> Result<usize, String> {
    let tx = c.unchecked_transaction().map_err(|e| e.to_string())?;
    let mut changed = 0;
    for part in &video.parts {
        let id = format!("bilibili:{}:{}", video.bvid, part.cid);
        let title = display_title(video, part);
        tx.execute(
            "UPDATE source_items SET aid=?2,page=?3,source_title=?4,uploader_id=?5,uploader_name=?6
             WHERE id=?1 AND (source_title='' OR source_title='B站歌曲（待加载）')",
            params![
                id,
                video.aid,
                part.page,
                title,
                video.uploader_id,
                video.uploader_name
            ],
        )
        .map_err(|e| e.to_string())?;
        changed += tx
            .execute(
                "UPDATE tracks SET title=?2,cover_url=?3,duration_seconds=?4
             WHERE id=?1 AND title='B站歌曲（待加载）'",
                params![id, title, part.cover_url, part.duration_seconds],
            )
            .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(changed)
}

pub(super) async fn hydrate_placeholders(
    database: &Database,
    provider: &BilibiliProvider,
    expected_session: &str,
    track_ids: Option<Vec<String>>,
) -> Result<usize, String> {
    let videos = {
        let c = database.0.lock().map_err(|_| "数据库正忙")?;
        if !matches_session(&c, expected_session)? {
            return Ok(0);
        }
        let mut q = c.prepare(
            "SELECT id,bvid FROM source_items WHERE source_title='' OR source_title='B站歌曲（待加载）'
             ORDER BY bvid LIMIT 5000",
        ).map_err(|e| e.to_string())?;
        let rows = q
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        rows.into_iter()
            .filter(|(id, _)| track_ids.as_ref().is_none_or(|ids| ids.contains(id)))
            .map(|(_, bvid)| bvid)
            .collect::<BTreeSet<_>>()
            .into_iter()
            .take(10)
            .collect::<Vec<_>>()
    };
    let mut changed = if track_ids.is_none() {
        crate::interface::linked_folders::hydrate_synced_links(database, expected_session)
            .await
            .unwrap_or(0)
    } else {
        0
    };
    for bvid in videos {
        {
            let c = database.0.lock().map_err(|_| "数据库正忙")?;
            if !matches_session(&c, expected_session)? {
                return Ok(0);
            }
        }
        let Ok(video) = provider
            .video_parts_with_priority(&bvid, RequestPriority::Background)
            .await
        else {
            break;
        };
        let Some(count) = save_for_session(database, expected_session, &video, save_placeholders)?
        else {
            return Ok(0);
        };
        changed += count;
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::repositories::library::{
        LibraryRepository, MetadataPatch, TrackInput,
    };

    #[tokio::test]
    async fn stalled_hydration_does_not_lock_sync_or_account_and_can_be_interrupted() {
        use tokio::sync::oneshot;
        let sync = super::super::SyncState::default();
        let database = Database(
            Mutex::new(Connection::open_in_memory().unwrap()),
            Default::default(),
        );
        let expected_session = account_session(&database.0.lock().unwrap()).unwrap();
        let (started, request_started) = oneshot::channel();
        let blocked = sync
            .source_hydration
            .run(&database, &expected_session, async {
                started.send(()).unwrap();
                std::future::pending().await
            });
        let account_change = async {
            request_started.await.unwrap();
            let _sync = sync.gate.try_lock().expect("hydration cannot block sync");
            let _account = sync
                .account_gate
                .try_lock()
                .expect("hydration cannot block profile changes");
            sync.interrupt();
        };
        let (result, ()) = tokio::join!(blocked, account_change);
        assert_eq!(result.unwrap(), 0);
        assert_eq!(
            sync.source_hydration
                .run(&database, &expected_session, async { Ok(1) })
                .await
                .unwrap(),
            1
        );
    }

    #[tokio::test]
    async fn stale_hydration_response_cannot_write_after_a_session_aba() {
        use tokio::sync::oneshot;
        let connection = Connection::open_in_memory().unwrap();
        crate::infrastructure::migrations::migrate(&connection).unwrap();
        let bvid = "BV1na4y1V7so";
        let id = format!("bilibili:{bvid}:1");
        connection
            .execute(
                "INSERT INTO source_items(id,provider,bvid,cid) VALUES(?1,'bilibili',?2,1)",
                params![id, bvid],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO tracks(id,source_item_id,title) VALUES(?1,?1,'B站歌曲（待加载）')",
                [&id],
            )
            .unwrap();
        let video = VideoParts {
            bvid: bvid.into(),
            aid: 1,
            title: "新标题".into(),
            cover_url: "https://bili.test/cover.jpg".into(),
            uploader_id: 1,
            uploader_name: "音乐".into(),
            access: None,
            play_count: Some(100),
            published_at: Some(1),
            season: None,
            parts: vec![VideoPart {
                cid: 1,
                page: 1,
                title: "第一集".into(),
                duration_seconds: 100,
                cover_url: "https://bili.test/cover.jpg".into(),
                first_frame_url: String::new(),
            }],
        };
        let expected_session = account_session(&connection).unwrap();
        let database = Database(Mutex::new(connection), Default::default());
        let hydration = Hydration::default();
        let (started, request_started) = oneshot::channel();
        let (finish, response) = oneshot::channel();
        let stale = hydration.run(&database, &expected_session, async {
            started.send(()).unwrap();
            response.await.unwrap();
            for write in [
                save as fn(&Connection, &VideoParts) -> Result<usize, String>,
                save_placeholders,
            ] {
                assert_eq!(
                    save_for_session(&database, &expected_session, &video, write)?,
                    None
                );
            }
            Ok(0)
        });
        let switched = async {
            request_started.await.unwrap();
            let c = database.0.lock().unwrap();
            for _ in 0..2 {
                c.execute(
                    "UPDATE account_session SET token=lower(hex(randomblob(16)))",
                    [],
                )
                .unwrap();
            }
            finish.send(()).unwrap();
        };
        let (result, ()) = tokio::join!(stale, switched);
        assert_eq!(result.unwrap(), 0);
        let current_session = {
            let c = database.0.lock().unwrap();
            assert!(!cache_is_fresh(&c, bvid));
            assert_eq!(
                c.query_row("SELECT title FROM tracks WHERE id=?1", [&id], |r| r
                    .get::<_, String>(0))
                    .unwrap(),
                "B站歌曲（待加载）"
            );
            account_session(&c).unwrap()
        };
        assert_eq!(
            save_for_session(&database, &current_session, &video, save_placeholders).unwrap(),
            Some(1)
        );
        assert_eq!(
            save_for_session(&database, &current_session, &video, save_placeholders).unwrap(),
            Some(0)
        );
    }

    #[test]
    fn legacy_metadata_cache_refreshes_artwork_once_and_keeps_its_expiry() {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        crate::infrastructure::migrations::migrate(&c).unwrap();
        let bvid = "BV1na4y1V7so";
        c.execute(
            "INSERT INTO sync_info(key,value) VALUES(?1,strftime('%s','now'))",
            [format!("source-title-chapter-v3-checked:{bvid}")],
        )
        .unwrap();
        for field in ["source-published", "source-plays"] {
            c.execute(
                "INSERT INTO sync_info(key,value) VALUES(?1,'0')",
                [format!("{field}:{bvid}")],
            )
            .unwrap();
        }
        assert!(!cache_is_fresh(&c, bvid));
        let id = format!("bilibili:{bvid}:1108732833");
        c.execute(
            "INSERT INTO source_items(id,provider,bvid,cid) VALUES(?1,'bilibili',?2,1108732833)",
            params![id, bvid],
        )
        .unwrap();
        c.execute("INSERT INTO tracks(id,source_item_id,title,cover_url) VALUES(?1,?1,'旧标题','https://bili.test/first.jpg')", [&id]).unwrap();
        let video = VideoParts {
            access: None,
            play_count: Some(100),
            published_at: Some(1),
            bvid: bvid.into(),
            aid: 1,
            title: "官方标题".into(),
            cover_url: "https://bili.test/cover.jpg".into(),
            uploader_name: "安州牧".into(),
            uploader_id: 1,
            season: None,
            parts: vec![crate::infrastructure::providers::bilibili::VideoPart {
                cid: 1108732833,
                page: 1,
                title: "第一集".into(),
                duration_seconds: 17325,
                cover_url: "https://bili.test/cover.jpg".into(),
                first_frame_url: "https://bili.test/first.jpg".into(),
            }],
        };
        assert!(save(&c, &video).unwrap() > 0);
        assert!(cache_is_fresh(&c, bvid));
        assert_eq!(
            LibraryRepository::get(&c, &id)
                .unwrap()
                .unwrap()
                .cover_url
                .as_deref(),
            Some("https://bili.test/cover.jpg")
        );
        assert_eq!(
            LibraryRepository::get(&c, &id)
                .unwrap()
                .unwrap()
                .duration_seconds,
            17325
        );
        assert_eq!(save(&c, &video).unwrap(), 0);
        c.execute(
            "UPDATE sync_info SET value=CAST(strftime('%s','now') AS INTEGER)-604801 WHERE key=?1",
            [format!("source-title-chapter-v3-checked:{bvid}")],
        )
        .unwrap();
        assert!(!cache_is_fresh(&c, bvid));
        assert!(!cache_is_fresh(&c, "BV1vW4y1i7qL"));
    }

    #[test]
    fn canonical_metadata_repairs_old_names_without_changing_identity_or_manual_title() {
        let mut c = rusqlite::Connection::open_in_memory().unwrap();
        crate::infrastructure::migrations::migrate(&c).unwrap();
        let input = TrackInput {
            id: "bilibili:BV1GFRFBREe6:38410979580".into(),
            bvid: "BV1GFRFBREe6".into(),
            cid: 38410979580,
            page: 1,
            aid: None,
            source_title: "04周旋权臣".into(),
            source_title_context: None,
            title: "04周旋权臣".into(),
            artist: None,
            album: None,
            cover_url: None,
            duration_seconds: 100,
            uploader_id: None,
            uploader_name: None,
        };
        LibraryRepository::upsert(&mut c, &input).unwrap();
        let video = VideoParts {
            access: None,
            play_count: Some(0),
            published_at: None,
            bvid: input.bvid.clone(),
            aid: 1,
            title: "AI喻大华 守成天子嘉庆 未删减版 04周旋权臣".into(),
            cover_url: String::new(),
            uploader_id: 1,
            uploader_name: String::new(),
            season: None,
            parts: vec![crate::infrastructure::providers::bilibili::VideoPart {
                cid: input.cid,
                page: 1,
                title: "四、周旋权臣".into(),
                duration_seconds: 100,
                cover_url: String::new(),
                first_frame_url: String::new(),
            }],
        };
        assert!(save(&c, &video).unwrap() > 0);
        assert_eq!(
            LibraryRepository::get(&c, &input.id)
                .unwrap()
                .unwrap()
                .title,
            video.title
        );
        assert_eq!(save(&c, &video).unwrap(), 0);
        let mut without_count = video.clone();
        without_count.play_count = None;
        assert_eq!(save(&c, &without_count).unwrap(), 0);
        assert_eq!(
            c.query_row(
                "SELECT value FROM sync_info WHERE key=?1",
                [format!("source-plays:{}", video.bvid)],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "0"
        );
        let mut chapter = video.clone();
        chapter.season = Some(crate::infrastructure::providers::bilibili::SeasonSummary {
            id: 1,
            uploader_id: 1,
            title: "守成天子嘉庆".into(),
            cover_url: String::new(),
            uploader_name: String::new(),
        });
        assert!(save(&c, &chapter).unwrap() > 0);
        assert_eq!(
            LibraryRepository::get(&c, &input.id)
                .unwrap()
                .unwrap()
                .source_display_title,
            "四、周旋权臣"
        );
        for generic in ["", "P1", "part 1", "正片", "视频", "默认标题"] {
            chapter.parts[0].title = generic.into();
            assert_eq!(display_title(&chapter, &chapter.parts[0]), video.title);
        }

        LibraryRepository::update_metadata(
            &c,
            &input.id,
            &MetadataPatch {
                title: "我的名称".into(),
                artist: None,
                album: None,
                cover_url: None,
            },
        )
        .unwrap();
        let mut multi = video.clone();
        multi.parts.push(multi.parts[0].clone());
        multi.parts[1].cid += 1;
        save(&c, &multi).unwrap();
        assert_eq!(
            LibraryRepository::get(&c, &input.id)
                .unwrap()
                .unwrap()
                .title,
            "我的名称"
        );
        assert_eq!(
            LibraryRepository::get(&c, &input.id)
                .unwrap()
                .unwrap()
                .source_display_title,
            "四、周旋权臣"
        );
        let cached: String = c
            .query_row(
                "SELECT value FROM sync_info WHERE key=?1",
                [format!("source-title:{}", input.id)],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(cached, "四、周旋权臣");
        let dir = std::env::temp_dir().join(format!("source-title-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        super::super::statistics::init(&c, &dir, "42").unwrap();
        let missing_id = format!("bilibili:{}:{}", video.bvid, video.parts[0].cid + 1);
        let mut bucket = super::super::statistics::Bucket::default();
        bucket.schema = 1;
        bucket.uid = "42".into();
        bucket.source = uuid::Uuid::new_v4().to_string();
        bucket.month = "baseline".into();
        bucket.revision = 1;
        bucket.tracks.insert(missing_id.clone(), 5340.0);
        bucket.tracks.insert(input.id.clone(), 200.0);
        bucket
            .names
            .insert(missing_id.clone(), ("旧统计名称".into(), String::new()));
        super::super::statistics::save(&c, &bucket, false, false).unwrap();
        let report = super::super::statistics::query(&c, &dir, "42").unwrap();
        assert_eq!(report["total"]["top"][0]["title"], "四、周旋权臣");
        assert_eq!(report["total"]["top"][0]["seconds"], 5340.0);
        assert_eq!(report["total"]["top"][1]["title"], "我的名称");
        assert_eq!(report["total"]["top"][1]["titleOverridden"], true);
        std::fs::remove_dir_all(dir).unwrap();

        // The second part is statistics-only: cache it without creating a library row.
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM tracks", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
}
