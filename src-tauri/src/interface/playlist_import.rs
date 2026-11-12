use crate::infrastructure::database::Database;
use crate::infrastructure::repositories::library::{LibraryRepository, MetadataPatch, TrackInput};
use crate::infrastructure::repositories::playlists::{PlaylistRecord, PlaylistRepository};
use crate::interface::error::CommandError;
use reqwest::{Client, Url};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::time::Duration;
use tauri::State;

const MAX_SONGS: usize = 5000;
const MAX_BODY: usize = 8 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalSong {
    source_id: String,
    title: String,
    artists: Vec<String>,
    aliases: Vec<String>,
    duration_seconds: f64,
    album: Option<String>,
    cover_url: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalPlaylist {
    name: String,
    source: String,
    songs: Vec<ExternalSong>,
    reported_count: usize,
    unavailable_count: usize,
}

fn allowed_host(host: &str) -> bool {
    host == "163cn.tv"
        || host == "music.163.com"
        || host.ends_with(".music.163.com")
        || host == "y.qq.com"
        || host.ends_with(".y.qq.com")
}

fn parse_input(input: &str) -> Result<Url, CommandError> {
    if input.len() > 16_000 {
        return Err(CommandError::validation("链接内容过长"));
    }
    let normalized = input
        .replace("https\\://", "https://")
        .replace("http\\://", "http://");
    let start = normalized
        .find("https://")
        .or_else(|| normalized.find("http://"))
        .ok_or_else(|| CommandError::validation("请粘贴网易云或 QQ 音乐的歌单分享链接"))?;
    let text = normalized[start..]
        .split_whitespace()
        .next()
        .unwrap_or("")
        .trim_end_matches([')', '）', '。', '，', '>', '】']);
    let url = Url::parse(text).map_err(|_| CommandError::validation("歌单链接无法识别"))?;
    check_url(&url)?;
    Ok(url)
}

fn check_url(url: &Url) -> Result<(), CommandError> {
    if !matches!(url.scheme(), "http" | "https")
        || !url.host_str().is_some_and(allowed_host)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return Err(CommandError::validation("仅支持网易云和 QQ 音乐的歌单链接"));
    }
    Ok(())
}

fn playlist_id(url: &Url) -> Option<(&'static str, String)> {
    let host = url.host_str()?;
    let source = if host == "music.163.com" || host.ends_with(".music.163.com") {
        "netease"
    } else if host == "y.qq.com" || host.ends_with(".y.qq.com") {
        "qq"
    } else {
        return None;
    };
    let mut pairs = url
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect::<Vec<_>>();
    if let Some(fragment) = url
        .fragment()
        .and_then(|fragment| fragment.split_once('?').map(|(_, query)| query))
    {
        pairs.extend(
            url::form_urlencoded::parse(fragment.as_bytes())
                .map(|(k, v)| (k.into_owned(), v.into_owned())),
        );
    }
    let query = pairs
        .into_iter()
        .find(|(key, value)| {
            matches!(key.as_str(), "id" | "disstid")
                && !value.is_empty()
                && value.len() <= 20
                && value.bytes().all(|b| b.is_ascii_digit())
        })
        .map(|(_, value)| value);
    let path = url
        .path_segments()
        .map(|segments| segments.collect::<Vec<_>>())
        .and_then(|segments| {
            segments
                .windows(2)
                .find(|pair| {
                    pair[0] == "playlist"
                        && !pair[1].is_empty()
                        && pair[1].len() <= 20
                        && pair[1].bytes().all(|b| b.is_ascii_digit())
                })
                .map(|pair| pair[1].to_owned())
        });
    // A song/user share URL also has id=; do not silently import a different resource.
    if !url.path().contains("playlist")
        && !url.path().contains("taoge")
        && !url.fragment().unwrap_or("").contains("playlist")
        && !url
            .query_pairs()
            .any(|(key, _)| source == "qq" && key == "disstid")
    {
        return None;
    }
    query.or(path).map(|id| (source, id))
}

async fn limited_body(mut response: reqwest::Response) -> Result<Vec<u8>, CommandError> {
    if response.content_length().unwrap_or(0) > MAX_BODY as u64 {
        return Err(CommandError::validation("歌单内容过大，请分批导入"));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| CommandError::provider("歌单读取中断，请重试"))?
    {
        if body.len() + chunk.len() > MAX_BODY {
            return Err(CommandError::validation("歌单内容过大，请分批导入"));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

async fn json(client: &Client, url: Url, referer: &'static str) -> Result<Value, CommandError> {
    let response = client
        .get(url)
        .header("Referer", referer)
        .send()
        .await
        .map_err(|_| CommandError::provider("暂时无法连接歌单服务，请重试或使用文本导入"))?;
    if !response.status().is_success() {
        return Err(CommandError::provider(
            "歌单服务暂时不可用，请稍后重试或使用文本导入",
        ));
    }
    serde_json::from_slice(&limited_body(response).await?)
        .map_err(|_| CommandError::provider("歌单内容暂时无法读取，请使用公开歌单链接或文本导入"))
}

fn names(value: &Value, key: &str) -> Vec<String> {
    value[key]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| v["name"].as_str())
        .filter(|name| !name.trim().is_empty())
        .map(|s| s.to_owned())
        .collect()
}
fn cover(value: &Value) -> Option<String> {
    let text = value.as_str()?;
    let url = Url::parse(text).ok()?;
    matches!(url.scheme(), "http" | "https").then(|| text.to_owned())
}
fn netease_song(song: &Value) -> Option<ExternalSong> {
    let title = song["name"].as_str()?.trim();
    if title.is_empty() {
        return None;
    }
    Some(ExternalSong {
        source_id: song["id"].to_string(),
        title: title.to_owned(),
        artists: names(song, "ar"),
        aliases: song["alia"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        duration_seconds: song["dt"].as_f64().unwrap_or(0.0) / 1000.0,
        album: song["al"]["name"].as_str().map(str::to_owned),
        cover_url: cover(&song["al"]["picUrl"]),
    })
}

async fn read_playlist(input: &str) -> Result<ExternalPlaylist, CommandError> {
    // Separate cookie-free client: never forward Bilibili login credentials to other services.
    let client = Client::builder()
        .timeout(Duration::from_secs(18))
        .user_agent("Mozilla/5.0")
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(CommandError::provider)?;
    let mut url = parse_input(input)?;
    let mut identity = playlist_id(&url);
    for _ in 0..5 {
        if identity.is_some() {
            break;
        }
        let response = client.get(url.clone()).send().await.map_err(|_| {
            CommandError::provider("分享链接暂时无法打开，请复制完整歌单链接或使用文本导入")
        })?;
        if !response.status().is_redirection() {
            break;
        }
        let location = response
            .headers()
            .get("location")
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| CommandError::validation("分享链接已失效，请复制完整歌单链接"))?;
        url = url
            .join(location)
            .map_err(|_| CommandError::validation("分享链接无法识别"))?;
        check_url(&url)?;
        identity = playlist_id(&url);
    }
    let (source, id) = identity.ok_or_else(|| {
        CommandError::validation("未找到歌单，请复制歌单分享链接，而不是歌曲或个人主页链接")
    })?;
    if source == "netease" {
        let data = json(
            &client,
            Url::parse_with_params(
                "https://music.163.com/api/v6/playlist/detail",
                &[("id", id.as_str())],
            )
            .unwrap(),
            "https://music.163.com/",
        )
        .await?;
        let playlist = &data["playlist"];
        if data["code"].as_i64() != Some(200) || !playlist.is_object() {
            return Err(CommandError::provider(
                "无法读取这份歌单，请确认已公开，或改用文本导入",
            ));
        }
        let mut seen = HashSet::new();
        let ids: Vec<i64> = playlist["trackIds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v["id"].as_i64())
            .filter(|id| *id > 0 && seen.insert(*id))
            .collect();
        if ids.len() > MAX_SONGS {
            return Err(CommandError::validation(
                "一次最多导入 5000 首，请将歌单分批导入",
            ));
        }
        let mut found = HashMap::new();
        for batch in ids.chunks(100) {
            let refs = Value::Array(
                batch
                    .iter()
                    .map(|id| serde_json::json!({"id":id}))
                    .collect(),
            )
            .to_string();
            let data = json(
                &client,
                Url::parse_with_params(
                    "https://music.163.com/api/v3/song/detail",
                    &[("c", refs.as_str())],
                )
                .unwrap(),
                "https://music.163.com/",
            )
            .await?;
            let songs = data["songs"]
                .as_array()
                .filter(|_| data["code"].as_i64() == Some(200))
                .ok_or_else(|| CommandError::provider("部分歌曲读取失败，请重试"))?;
            for song in songs {
                if let (Some(id), Some(song)) = (song["id"].as_i64(), netease_song(song)) {
                    found.insert(id, song);
                }
            }
        }
        let songs: Vec<_> = ids.iter().filter_map(|id| found.remove(id)).collect();
        let reported = playlist["trackCount"].as_u64().unwrap_or(ids.len() as u64) as usize;
        return Ok(ExternalPlaylist {
            name: playlist["name"].as_str().unwrap_or("网易云歌单").to_owned(),
            source: source.into(),
            reported_count: reported,
            unavailable_count: reported.saturating_sub(songs.len()),
            songs,
        });
    }
    let url = Url::parse_with_params(
        "https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg",
        &[
            ("type", "1"),
            ("json", "1"),
            ("utf8", "1"),
            ("onlysong", "0"),
            ("disstid", id.as_str()),
            ("format", "json"),
            ("g_tk", "5381"),
        ],
    )
    .unwrap();
    let data = json(&client, url, "https://y.qq.com/").await?;
    let cd = &data["cdlist"][0];
    let items = cd["songlist"]
        .as_array()
        .filter(|_| data["code"].as_i64() == Some(0))
        .ok_or_else(|| {
            CommandError::provider("无法读取这份 QQ 歌单，请确认已公开，或改用文本导入")
        })?;
    if items.len() > MAX_SONGS {
        return Err(CommandError::validation(
            "一次最多导入 5000 首，请将歌单分批导入",
        ));
    }
    let mut seen = HashSet::new();
    let songs: Vec<_> = items
        .iter()
        .filter_map(|s| {
            let title = s["songname"].as_str()?.trim();
            let id = s["songid"].to_string();
            if title.is_empty() || !seen.insert(id.clone()) {
                return None;
            }
            Some(ExternalSong {
                source_id: id,
                title: title.into(),
                artists: names(s, "singer"),
                aliases: vec![],
                duration_seconds: s["interval"].as_f64().unwrap_or(0.0),
                album: s["albumname"].as_str().map(str::to_owned),
                cover_url: None,
            })
        })
        .collect();
    let reported = cd["songnum"].as_u64().unwrap_or(items.len() as u64) as usize;
    Ok(ExternalPlaylist {
        name: cd["dissname"].as_str().unwrap_or("QQ 音乐歌单").into(),
        source: source.into(),
        reported_count: reported,
        unavailable_count: reported.saturating_sub(songs.len()),
        songs,
    })
}

#[tauri::command]
pub async fn external_playlist_read(input: String) -> Result<ExternalPlaylist, CommandError> {
    read_playlist(&input).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportEntry {
    track: TrackInput,
    metadata: Option<MetadataPatch>,
    replace_track_id: Option<String>,
}

pub(crate) fn scope(connection: &Connection) -> String {
    connection
        .path()
        .and_then(|path| std::path::Path::new(path).file_name())
        .and_then(|name| name.to_str())
        .filter(|path| !path.is_empty())
        .unwrap_or("memory")
        .to_owned()
}

#[tauri::command]
pub fn playlist_import_scope(database: State<'_, Database>) -> Result<String, CommandError> {
    let connection = database.0.lock().map_err(CommandError::database)?;
    Ok(scope(&connection))
}

fn commit(
    connection: &mut Connection,
    expected_scope: &str,
    playlist_id: &str,
    name: &str,
    entries: &[ImportEntry],
) -> Result<PlaylistRecord, CommandError> {
    if scope(connection) != expected_scope {
        return Err(CommandError::validation("账号已切换，请重新打开导入页面"));
    }
    if entries.is_empty()
        || entries.len() > 100
        || name.trim().is_empty()
        || name.chars().count() > 80
        || !playlist_id.starts_with("import:")
        || playlist_id.len() > 100
    {
        return Err(CommandError::validation("导入内容无效"));
    }
    for entry in entries {
        let t = &entry.track;
        if t.cid <= 0
            || t.page < 1
            || !t.bvid.starts_with("BV")
            || t.bvid.len() != 12
            || !t.bvid.bytes().all(|c| c.is_ascii_alphanumeric())
            || t.id != format!("bilibili:{}:{}", t.bvid, t.cid)
            || t.title.is_empty()
            || t.title.chars().count() > 1000
        {
            return Err(CommandError::validation("歌曲来源不完整，请重新匹配"));
        }
        if entry
            .metadata
            .as_ref()
            .is_some_and(|m| m.title.trim().is_empty() || m.title.chars().count() > 1000)
        {
            return Err(CommandError::validation("歌曲信息无效"));
        }
    }
    let tx = connection.transaction().map_err(CommandError::database)?;
    let exists = tx
        .query_row("SELECT 1 FROM playlists WHERE id=?1", [playlist_id], |r| {
            r.get::<_, i64>(0)
        })
        .optional()
        .map_err(CommandError::database)?
        .is_some();
    if !exists {
        if entries.iter().any(|entry| entry.replace_track_id.is_some()) {
            return Err(CommandError::validation("歌单已删除，请重新打开"));
        }
        PlaylistRepository::create(&tx, playlist_id, name).map_err(CommandError::database)?;
    }
    let mut position: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(position)+1,0) FROM playlist_items WHERE playlist_id=?1",
            [playlist_id],
            |r| r.get(0),
        )
        .map_err(CommandError::database)?;
    for entry in entries {
        let track = &entry.track;
        let replacement_position: Option<i64> = entry
            .replace_track_id
            .as_ref()
            .filter(|old| *old != &track.id)
            .map(|old| {
                tx.query_row(
                    "SELECT position FROM playlist_items WHERE playlist_id=?1 AND track_id=?2",
                    params![playlist_id, old],
                    |r| r.get(0),
                )
                .optional()
            })
            .transpose()
            .map_err(CommandError::database)?
            .flatten();
        if entry
            .replace_track_id
            .as_ref()
            .is_some_and(|old| old != &track.id)
            && replacement_position.is_none()
        {
            return Err(CommandError::validation("这首歌已从歌单移除，请重新打开"));
        }
        if LibraryRepository::get(&tx, &track.id)
            .map_err(CommandError::database)?
            .is_none()
        {
            tx.execute("INSERT INTO source_items(id,provider,bvid,aid,cid,page,source_title,uploader_id,uploader_name) VALUES(?1,'bilibili',?2,?3,?4,?5,?6,?7,?8)", params![track.id,track.bvid,track.aid,track.cid,track.page,track.source_title,track.uploader_id,track.uploader_name]).map_err(CommandError::database)?;
            tx.execute("INSERT INTO tracks(id,source_item_id,title,artist,album,cover_url,duration_seconds) VALUES(?1,?1,?2,?3,?4,?5,?6)",params![track.id,track.title,track.artist,track.album,track.cover_url,track.duration_seconds]).map_err(CommandError::database)?;
        }
        if let Some(m) = &entry.metadata {
            tx.execute("INSERT INTO metadata_overrides(track_id,title,artist,album,cover_url) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(track_id) DO NOTHING",params![track.id,m.title,m.artist,m.album,m.cover_url]).map_err(CommandError::database)?;
        }
        let inserted = tx.execute("INSERT OR IGNORE INTO playlist_items(playlist_id,track_id,position) VALUES(?1,?2,?3)",params![playlist_id,track.id,replacement_position.unwrap_or(position)]).map_err(CommandError::database)?;
        if let Some(old) = entry
            .replace_track_id
            .as_ref()
            .filter(|old| *old != &track.id)
        {
            tx.execute(
                "DELETE FROM playlist_items WHERE playlist_id=?1 AND track_id=?2",
                params![playlist_id, old],
            )
            .map_err(CommandError::database)?;
        }
        position += inserted as i64;
    }
    tx.execute(
        "UPDATE playlists SET updated_at=strftime('%Y-%m-%d %H:%M:%f','now') WHERE id=?1",
        [playlist_id],
    )
    .map_err(CommandError::database)?;
    tx.commit().map_err(CommandError::database)?;
    PlaylistRepository::get(connection, playlist_id).map_err(CommandError::database)
}

#[tauri::command]
pub fn playlist_import_commit(
    database: State<'_, Database>,
    expected_scope: String,
    playlist_id: String,
    name: String,
    entries: Vec<ImportEntry>,
) -> Result<PlaylistRecord, CommandError> {
    let mut connection = database.0.lock().map_err(CommandError::database)?;
    commit(
        &mut connection,
        &expected_scope,
        &playlist_id,
        &name,
        &entries,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    #[ignore = "live public playlist metadata"]
    async fn live_external_playlist_metadata() {
        let input = std::env::var("BILIMUSIC_TEST_PLAYLIST")
            .unwrap_or_else(|_| "https://music.163.com/playlist?id=3778678".into());
        let list = read_playlist(&input).await.unwrap();
        assert_eq!(list.source, "netease");
        assert!(list.songs.len() > 100);
        assert!(!list.songs[0].source_id.is_empty());
        assert!(!list.songs[0].title.is_empty());
        assert!(list.songs[0].duration_seconds > 0.0);
        assert!(list.songs[0].cover_url.is_some());
        let qq = read_playlist("https://y.qq.com/n/ryqq_v2/playlist/7346601611")
            .await
            .unwrap();
        assert_eq!(qq.source, "qq");
        assert!(!qq.songs.is_empty());
    }
    #[test]
    fn recognizes_share_links_and_rejects_unrelated_hosts_and_resources() {
        for (input, expected) in [
            (
                "分享歌单 https://music.163.com/#/playlist?id=519816720",
                ("netease", "519816720"),
            ),
            (
                "https://y.qq.com/n/ryqq_v2/playlist/7346601611",
                ("qq", "7346601611"),
            ),
            (
                "https://i.y.qq.com/n2/m/share/details/taoge.html?id=123456",
                ("qq", "123456"),
            ),
        ] {
            let (source, id) = playlist_id(&parse_input(input).unwrap()).unwrap();
            assert_eq!((source, id.as_str()), expected);
        }
        assert!(parse_input("https://music.163.com.evil.test/playlist?id=123").is_err());
        assert!(parse_input("https://music.163.com:444/playlist?id=123").is_err());
        assert!(playlist_id(&parse_input("https://music.163.com/song?id=123").unwrap()).is_none());
        assert!(playlist_id(&parse_input("https://163cn.tv/bkLZf8lo").unwrap()).is_none());
    }
    #[test]
    fn import_is_idempotent_ordered_profile_scoped_and_keeps_existing_edits() {
        let mut c = Connection::open_in_memory().unwrap();
        c.execute_batch(include_str!("../../migrations/0001_initial.sql"))
            .unwrap();
        let entry = |cid| ImportEntry {
            track: TrackInput {
                id: format!("bilibili:BV1GJ411x7h7:{cid}"),
                bvid: "BV1GJ411x7h7".into(),
                aid: None,
                cid,
                page: cid as i32,
                source_title: "BV".into(),
                title: format!("P{cid}"),
                artist: None,
                album: None,
                cover_url: None,
                duration_seconds: 200,
                uploader_id: Some(7),
                uploader_name: Some("UP".into()),
            },
            metadata: Some(MetadataPatch {
                title: "歌曲".into(),
                artist: Some("歌手".into()),
                album: None,
                cover_url: None,
            }),
            replace_track_id: None,
        };
        let rows = vec![entry(1), entry(2)];
        assert!(commit(&mut c, "other-profile", "import:test", "歌单", &rows).is_err());
        assert_eq!(
            commit(&mut c, "memory", "import:test", "歌单", &rows)
                .unwrap()
                .track_count,
            2
        );
        c.execute(
            "UPDATE metadata_overrides SET title='用户编辑' WHERE track_id=?1",
            [&rows[0].track.id],
        )
        .unwrap();
        assert_eq!(
            commit(&mut c, "memory", "import:test", "歌单", &rows)
                .unwrap()
                .track_count,
            2
        );
        let tracks = PlaylistRepository::tracks(&c, "import:test").unwrap();
        assert_eq!(tracks[0].cid, 1);
        assert_eq!(tracks[1].cid, 2);
        assert_eq!(tracks[0].title, "用户编辑");
        assert_eq!(tracks[0].uploader_name.as_deref(), Some("UP"));
        let bad = vec![entry(3), entry(0)];
        assert!(commit(&mut c, "memory", "import:test", "歌单", &bad).is_err());
        assert_eq!(
            PlaylistRepository::tracks(&c, "import:test").unwrap().len(),
            2
        );
        let mut replacement = entry(3);
        replacement.replace_track_id = Some(rows[0].track.id.clone());
        commit(&mut c, "memory", "import:other", "另一个歌单", &[entry(1)]).unwrap();
        c.execute(
            "INSERT INTO favorites(track_id) VALUES(?1)",
            [&rows[0].track.id],
        )
        .unwrap();
        commit(&mut c, "memory", "import:test", "歌单", &[replacement]).unwrap();
        assert_eq!(
            PlaylistRepository::tracks(&c, "import:other").unwrap()[0].cid,
            1
        );
        assert_eq!(
            c.query_row(
                "SELECT COUNT(*) FROM favorites WHERE track_id=?1",
                [&rows[0].track.id],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        let mut stale = entry(4);
        stale.replace_track_id = Some(rows[0].track.id.clone());
        assert!(commit(&mut c, "memory", "import:test", "歌单", &[stale]).is_err());
        let mut deleted = entry(4);
        deleted.replace_track_id = Some(rows[0].track.id.clone());
        assert!(commit(&mut c, "memory", "import:deleted", "歌单", &[deleted]).is_err());
        assert_eq!(
            c.query_row(
                "SELECT COUNT(*) FROM playlists WHERE id='import:deleted'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        assert_eq!(
            PlaylistRepository::tracks(&c, "import:test")
                .unwrap()
                .iter()
                .map(|track| track.cid)
                .collect::<Vec<_>>(),
            vec![3, 2]
        );
        c.execute_batch("CREATE TEMP TRIGGER reject_import BEFORE INSERT ON tracks WHEN NEW.id='bilibili:BV1GJ411x7h7:5' BEGIN SELECT RAISE(ABORT,'fixture failure'); END;").unwrap();
        assert!(
            commit(
                &mut c,
                "memory",
                "import:test",
                "歌单",
                &[entry(4), entry(5)]
            )
            .is_err()
        );
        assert!(
            LibraryRepository::get(&c, "bilibili:BV1GJ411x7h7:4")
                .unwrap()
                .is_none()
        );
        assert_eq!(
            PlaylistRepository::tracks(&c, "import:test").unwrap().len(),
            2
        );
    }
}
