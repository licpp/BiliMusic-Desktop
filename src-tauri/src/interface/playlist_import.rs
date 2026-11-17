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

pub(super) const MAX_SONGS: usize = 5000;
const MAX_BODY: usize = 8 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalSong {
    pub(super) source_id: String,
    pub(super) title: String,
    pub(super) artists: Vec<String>,
    pub(super) aliases: Vec<String>,
    pub(super) duration_seconds: f64,
    pub(super) album: Option<String>,
    pub(super) cover_url: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalPlaylist {
    pub(super) name: String,
    pub(super) source: String,
    pub(super) songs: Vec<ExternalSong>,
    pub(super) reported_count: usize,
    pub(super) unavailable_count: usize,
}

fn allowed_host(host: &str) -> bool {
    matches!(
        host,
        "kugou.com"
            | "m.kugou.com"
            | "www.kugou.com"
            | "m3ws.kugou.com"
            | "t.kugou.com"
            | "kuwo.cn"
            | "www.kuwo.cn"
            | "m.kuwo.cn"
            | "h5app.kuwo.cn"
            | "music.migu.cn"
            | "m.music.migu.cn"
            | "h5.nf.migu.cn"
            | "c.migu.cn"
    ) || host == "163cn.tv"
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
        .ok_or_else(|| {
            CommandError::validation("请粘贴网易云、QQ、酷狗、酷我或咪咕的歌单分享链接")
        })?;
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
        return Err(CommandError::validation("请使用支持的音乐平台歌单分享链接"));
    }
    Ok(())
}

fn playlist_id(url: &Url) -> Option<(&'static str, String)> {
    let host = url.host_str()?;
    if let Some(fragment) = url
        .fragment()
        .filter(|f| f.contains("playlist") && f.contains('?'))
    {
        if let Ok(nested) = Url::parse(&format!(
            "https://{host}/{}",
            fragment.trim_start_matches('/')
        )) {
            if let Some(result) = playlist_id(&nested) {
                return Some(result);
            }
        }
    }
    if matches!(
        host,
        "kugou.com" | "m.kugou.com" | "www.kugou.com" | "m3ws.kugou.com"
    ) {
        if let Some(id) = url.path_segments().into_iter().flatten().find(|s| {
            s.starts_with("gcid_")
                && s.len() < 100
                && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
        }) {
            return Some(("kugou", id.into()));
        }
    }
    if matches!(
        host,
        "kugou.com" | "m.kugou.com" | "www.kugou.com" | "m3ws.kugou.com"
    ) {
        if let Some((_, id)) = url.query_pairs().find(|(k, v)| {
            k == "global_collection_id"
                && v.len() <= 100
                && v.starts_with("collection_")
                && v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
        }) {
            return Some(("kugou", id.into_owned()));
        }
        if url.path().contains("/special/single/") {
            if let Some(id) = url
                .path()
                .split('/')
                .next_back()
                .and_then(|s| s.strip_suffix(".html"))
                .filter(|s| s.len() <= 20 && !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
            {
                return Some(("kugou", format!("special:{id}")));
            }
        }
    }
    if matches!(
        host,
        "kuwo.cn"
            | "www.kuwo.cn"
            | "m.kuwo.cn"
            | "h5app.kuwo.cn"
            | "music.migu.cn"
            | "m.music.migu.cn"
            | "h5.nf.migu.cn"
    ) {
        let source = if host.ends_with("kuwo.cn") {
            "kuwo"
        } else {
            "migu"
        };
        if source == "migu" && !url.path().contains("playlist") {
            return None;
        }
        let id = url
            .path_segments()
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .windows(2)
            .find(|w| matches!(w[0], "playlist" | "playlist_detail"))
            .map(|w| w[1].to_owned())
            .filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
            .or_else(|| {
                url.query_pairs()
                    .find(|(k, _)| {
                        if source == "kuwo" {
                            matches!(k.as_ref(), "pid" | "playlistId")
                        } else {
                            matches!(k.as_ref(), "id" | "playlistId")
                        }
                    })
                    .map(|(_, v)| v.into_owned())
            });
        if let Some(id) =
            id.filter(|s| !s.is_empty() && s.len() <= 20 && s.bytes().all(|b| b.is_ascii_digit()))
        {
            return Some((source, id));
        }
    }
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

pub(super) async fn limited_body(mut response: reqwest::Response) -> Result<Vec<u8>, CommandError> {
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

pub(super) async fn json(
    client: &Client,
    url: Url,
    referer: &'static str,
) -> Result<Value, CommandError> {
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

fn split_artist(name: &str) -> Vec<String> {
    let name = name.trim();
    let Some(index) = name.rfind(|c| c == '(' || c == '（') else {
        return vec![name.to_owned()];
    };
    let outer = name[..index].trim();
    let inner = name[index..]
        .chars()
        .skip(1)
        .collect::<String>()
        .trim()
        .trim_end_matches(|c| c == ')' || c == '）')
        .trim()
        .to_owned();
    if outer.is_empty()
        || inner.is_empty()
        || inner
            .chars()
            .any(|c| matches!(c, '/' | '、' | ',' | '，' | '(' | '（'))
    {
        return vec![name.to_owned()];
    }
    vec![outer.to_owned(), inner]
}

fn qq_artists(song: &Value) -> Vec<String> {
    names(song, "singer")
        .into_iter()
        .flat_map(|name| split_artist(&name))
        .collect()
}

fn qq_song(song: &Value) -> Option<ExternalSong> {
    let title = song["songname"].as_str()?.trim();
    if title.is_empty() {
        return None;
    }
    let original = song["songorig"]
        .as_str()
        .map(str::trim)
        .filter(|name| !name.is_empty() && *name != title);
    Some(ExternalSong {
        source_id: song["songid"].to_string(),
        title: title.to_owned(),
        artists: qq_artists(song),
        aliases: original.into_iter().map(str::to_owned).collect(),
        duration_seconds: song["interval"].as_f64().unwrap_or(0.0),
        album: song["albumname"]
            .as_str()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_owned),
        cover_url: None,
    })
}

fn qq_page_url(id: &str, begin: usize) -> Url {
    Url::parse_with_params(
        "https://i.y.qq.com/qzone-music/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg",
        &[
            ("type", "1"),
            ("json", "1"),
            ("utf8", "1"),
            ("onlysong", "0"),
            ("nosign", "1"),
            ("disstid", id),
            ("format", "json"),
            ("g_tk", "5381"),
            ("loginUin", "0"),
            ("hostUin", "0"),
            ("inCharset", "utf8"),
            ("outCharset", "utf-8"),
            ("notice", "0"),
            ("platform", "yqq"),
            ("needNewCode", "0"),
            ("song_begin", &begin.to_string()),
            ("song_num", "100"),
        ],
    )
    .unwrap()
}

async fn read_playlist(input: &str) -> Result<ExternalPlaylist, CommandError> {
    // Separate cookie-free client: never forward Bilibili login credentials to other services.
    let client = Client::builder()
        .timeout(Duration::from_secs(18))
        .user_agent(
            "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36",
        )
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
    if matches!(source, "kugou" | "kuwo" | "migu") {
        return super::playlist_sources::read(&client, source, &id).await;
    }
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
    let mut songs = Vec::new();
    let mut seen = HashSet::new();
    let mut name = "QQ 音乐歌单".to_owned();
    let mut reported = 0usize;
    let mut begin = 0usize;
    loop {
        let data = json(&client, qq_page_url(&id, begin), "https://y.qq.com/").await?;
        if data["code"].as_i64() != Some(0) || data["subcode"].as_i64().unwrap_or(0) != 0 {
            return Err(CommandError::provider(
                "无法读取这份 QQ 歌单，请确认已公开，或改用文本导入",
            ));
        }
        let cd = &data["cdlist"][0];
        if begin == 0 {
            if let Some(title) = cd["dissname"]
                .as_str()
                .map(str::trim)
                .filter(|title| !title.is_empty())
            {
                name = title.to_owned();
            }
            reported = cd["total_song_num"]
                .as_u64()
                .or(cd["songnum"].as_u64())
                .unwrap_or(0) as usize;
            if reported > MAX_SONGS {
                return Err(CommandError::validation(
                    "一次最多导入 5000 首，请将歌单分批导入",
                ));
            }
        }
        let Some(items) = cd["songlist"].as_array().filter(|items| !items.is_empty()) else {
            break;
        };
        let before = songs.len();
        for song in items {
            let Some(song) = qq_song(song) else { continue };
            if !seen.insert(song.source_id.clone()) {
                continue;
            }
            songs.push(song);
            if songs.len() > MAX_SONGS {
                return Err(CommandError::validation(
                    "一次最多导入 5000 首，请将歌单分批导入",
                ));
            }
        }
        begin += items.len();
        if songs.len() == before {
            return Err(CommandError::provider(
                "QQ 歌单分页未推进，请稍后重试或使用文本导入",
            ));
        }
        if reported > 0 && songs.len() >= reported || reported == 0 && items.len() < 100 {
            break;
        }
        if begin > MAX_SONGS * 2 {
            return Err(CommandError::provider(
                "QQ 歌单分页过多，请稍后重试或使用文本导入",
            ));
        }
    }
    if songs.is_empty() {
        return Err(CommandError::provider(
            "无法读取这份 QQ 歌单，请确认已公开，或改用文本导入",
        ));
    }
    Ok(ExternalPlaylist {
        name,
        source: source.into(),
        reported_count: reported.max(songs.len()),
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
    #[serde(default)]
    original_position: Option<usize>,
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
        if entry.original_position.is_some_and(|p| p >= MAX_SONGS) {
            return Err(CommandError::validation("导入序号无效"));
        }
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
    let mut archived: Vec<(usize, String)> = connection_archive_rows(&tx, playlist_id);
    archived.sort_unstable_by_key(|(order, _)| *order);
    let mut archive: Option<Value> = tx
        .query_row(
            "SELECT document FROM playlist_import_archives WHERE playlist_id=?1",
            [playlist_id],
            |r| r.get::<_, String>(0),
        )
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok());
    let mut positions: HashMap<String, i64> = tx
        .prepare("SELECT track_id,position FROM playlist_items WHERE playlist_id=?1")
        .map_err(CommandError::database)?
        .query_map([playlist_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(CommandError::database)?
        .collect::<Result<_, _>>()
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
        if replacement_position.is_some() && positions.contains_key(&track.id) {
            return Err(CommandError::validation("该版本已在歌单中，请选择其他视频"));
        }
        let mut destination = replacement_position.unwrap_or(position);
        if replacement_position.is_none() && !positions.contains_key(&track.id) {
            if let Some(order) = entry.original_position {
                destination = archived
                    .iter()
                    .find(|(i, id)| *i > order && positions.contains_key(id))
                    .and_then(|(_, id)| positions.get(id))
                    .copied()
                    .or_else(|| {
                        archived
                            .iter()
                            .rev()
                            .find(|(i, id)| *i < order && positions.contains_key(id))
                            .and_then(|(_, id)| positions.get(id))
                            .map(|p| p + 1)
                    })
                    .unwrap_or(0);
                tx.execute("UPDATE playlist_items SET position=position+1 WHERE playlist_id=?1 AND position>=?2",params![playlist_id,destination]).map_err(CommandError::database)?;
                for value in positions.values_mut() {
                    if *value >= destination {
                        *value += 1
                    }
                }
            }
        }
        let inserted = tx.execute("INSERT OR IGNORE INTO playlist_items(playlist_id,track_id,position) VALUES(?1,?2,?3)",params![playlist_id,track.id,destination]).map_err(CommandError::database)?;
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
        if let Some(old) = entry
            .replace_track_id
            .as_ref()
            .filter(|old| *old != &track.id)
        {
            positions.remove(old);
        }
        if let Some(order) = entry.original_position {
            if let Some(row) = archive
                .as_mut()
                .and_then(|a| a["rows"].as_array_mut())
                .and_then(|rows| {
                    rows.iter_mut()
                        .find(|row| row["order"].as_u64() == Some(order as u64))
                })
            {
                row["status"] = serde_json::json!("saved");
                row["chosen"] = serde_json::json!({"track":{"id":track.id,"title":track.title,"durationSeconds":track.duration_seconds,"liked":false,"source":{"provider":"bilibili","bvid":track.bvid,"aid":track.aid,"cid":track.cid,"page":track.page,"uploaderId":track.uploader_id,"uploaderName":track.uploader_name}},"evidence":{"bvid":track.bvid,"cid":track.cid,"title":track.title,"detailsVerified":true}});
            }
        }
        if inserted > 0 {
            positions.insert(track.id.clone(), destination);
        }
        if let Some(order) = entry.original_position {
            archived.retain(|(index, _)| *index != order);
            archived.push((order, track.id.clone()));
            archived.sort_unstable_by_key(|(index, _)| *index);
        }
        position = positions.values().max().map(|p| p + 1).unwrap_or(0);
    }
    if let Some(archive) = archive {
        tx.execute("UPDATE playlist_import_archives SET document=?2,updated_at=CURRENT_TIMESTAMP WHERE playlist_id=?1",params![playlist_id,archive.to_string()]).map_err(CommandError::database)?;
    }
    tx.execute(
        "UPDATE playlists SET updated_at=strftime('%Y-%m-%d %H:%M:%f','now') WHERE id=?1",
        [playlist_id],
    )
    .map_err(CommandError::database)?;
    tx.commit().map_err(CommandError::database)?;
    PlaylistRepository::get(connection, playlist_id).map_err(CommandError::database)
}

fn connection_archive_rows(c: &Connection, id: &str) -> Vec<(usize, String)> {
    c.query_row(
        "SELECT document FROM playlist_import_archives WHERE playlist_id=?1",
        [id],
        |r| r.get::<_, String>(0),
    )
    .ok()
    .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
    .and_then(|v| {
        v["rows"].as_array().map(|rows| {
            rows.iter()
                .enumerate()
                .filter_map(|(_i, row)| {
                    row["chosen"]["track"]["id"].as_str().and_then(|id| {
                        row["order"]
                            .as_u64()
                            .map(|order| (order as usize, id.to_owned()))
                    })
                })
                .collect()
        })
    })
    .unwrap_or_default()
}
#[tauri::command]
pub fn playlist_import_archive(
    database: State<'_, Database>,
    expected_scope: String,
    expected_account_session: Option<String>,
    playlist_id: String,
    document: Option<String>,
) -> Result<Option<String>, CommandError> {
    let c = database.0.lock().map_err(CommandError::database)?;
    if let Some(expected) = expected_account_session {
        if crate::infrastructure::database::account_session(&c).map_err(CommandError::database)?
            != expected
        {
            return Err(CommandError::validation("账号已切换，请重新打开导入页面"));
        }
    }
    if scope(&c) != expected_scope {
        return Err(CommandError::validation("账号已切换，请重新打开导入页面"));
    }
    if !playlist_id.starts_with("import:") || playlist_id.len() > 100 {
        return Err(CommandError::validation("无效的导入歌单"));
    }
    if let Some(document) = document {
        if document.len() > 8 * 1024 * 1024 {
            return Err(CommandError::validation("导入进度过大"));
        }
        let value: Value = serde_json::from_str(&document)
            .map_err(|_| CommandError::validation("导入进度无效"))?;
        if value["playlistId"].as_str() != Some(playlist_id.as_str())
            || value["scope"].as_str() != Some(expected_scope.as_str())
            || !value["rows"]
                .as_array()
                .is_some_and(|r| r.len() <= MAX_SONGS)
        {
            return Err(CommandError::validation("导入进度身份无效"));
        }
        c.execute("INSERT INTO playlist_import_archives(playlist_id,document) VALUES(?1,?2) ON CONFLICT(playlist_id) DO UPDATE SET document=excluded.document,updated_at=CURRENT_TIMESTAMP",params![playlist_id,document]).map_err(CommandError::database)?;
        return Ok(None);
    }
    c.query_row(
        "SELECT document FROM playlist_import_archives WHERE playlist_id=?1",
        [playlist_id],
        |r| r.get(0),
    )
    .optional()
    .map_err(CommandError::database)
}

#[tauri::command]
pub fn playlist_import_commit(
    database: State<'_, Database>,
    expected_scope: String,
    expected_account_session: Option<String>,
    playlist_id: String,
    name: String,
    entries: Vec<ImportEntry>,
) -> Result<PlaylistRecord, CommandError> {
    let mut connection = database.0.lock().map_err(CommandError::database)?;
    if let Some(expected) = expected_account_session {
        if crate::infrastructure::database::account_session(&connection)
            .map_err(CommandError::database)?
            != expected
        {
            return Err(CommandError::validation("账号已切换，请重新打开导入页面"));
        }
    }
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
    fn ordered_entry(cid: i64, order: Option<usize>) -> ImportEntry {
        ImportEntry {
            track: TrackInput {
                id: format!("bilibili:BV1GJ411x7h7:{cid}"),
                bvid: "BV1GJ411x7h7".into(),
                aid: Some(1),
                cid,
                page: 1,
                source_title: "视频".into(),
                source_title_context: None,
                title: format!("歌曲{cid}"),
                artist: None,
                album: None,
                cover_url: None,
                duration_seconds: 120,
                uploader_id: None,
                uploader_name: None,
            },
            metadata: None,
            replace_track_id: None,
            original_position: order,
        }
    }
    #[test]
    fn filling_and_replacing_gaps_preserves_original_order_and_atomic_archive() {
        let mut c = Connection::open_in_memory().unwrap();
        crate::infrastructure::migrations::migrate(&c).unwrap();
        let document = serde_json::json!({"rows":(0..4).map(|i|serde_json::json!({"order":i,"status":"missing"})).collect::<Vec<_>>()});
        c.execute(
            "INSERT INTO playlist_import_archives(playlist_id,document) VALUES('import:order',?1)",
            [document.to_string()],
        )
        .unwrap();
        commit(
            &mut c,
            "memory",
            "import:order",
            "原顺序",
            &[ordered_entry(1, Some(0)), ordered_entry(3, Some(2))],
        )
        .unwrap();
        // A normal addition can be prepended without consuming an original gap.
        commit(
            &mut c,
            "memory",
            "import:order",
            "原顺序",
            &[ordered_entry(99, None)],
        )
        .unwrap();
        PlaylistRepository::add_tracks(
            &c,
            "import:order",
            &["bilibili:BV1GJ411x7h7:99".into()],
            false,
        )
        .unwrap();
        commit(
            &mut c,
            "memory",
            "import:order",
            "原顺序",
            &[ordered_entry(2, Some(1)), ordered_entry(4, Some(3))],
        )
        .unwrap();
        let ids = |c: &Connection| {
            PlaylistRepository::tracks(c, "import:order")
                .unwrap()
                .into_iter()
                .map(|t| t.cid)
                .collect::<Vec<_>>()
        };
        assert_eq!(ids(&c), vec![99, 1, 2, 3, 4]);
        let mut replacement = ordered_entry(20, Some(1));
        replacement.replace_track_id = Some("bilibili:BV1GJ411x7h7:2".into());
        commit(&mut c, "memory", "import:order", "原顺序", &[replacement]).unwrap();
        assert_eq!(ids(&c), vec![99, 1, 20, 3, 4]);
        let archive = || {
            c.query_row(
                "SELECT document FROM playlist_import_archives WHERE playlist_id='import:order'",
                [],
                |r| r.get::<_, String>(0),
            )
            .unwrap()
        };
        let updated: Value = serde_json::from_str(&archive()).unwrap();
        assert_eq!(
            updated["rows"][1]["chosen"]["track"]["id"],
            "bilibili:BV1GJ411x7h7:20"
        );
        let before = archive();
        // A stale replacement and a duplicate must both leave playlist and archive intact.
        let mut stale = ordered_entry(40, Some(1));
        stale.replace_track_id = Some("bilibili:BV1GJ411x7h7:2".into());
        assert!(commit(&mut c, "memory", "import:order", "原顺序", &[stale]).is_err());
        let mut duplicate = ordered_entry(3, Some(1));
        duplicate.replace_track_id = Some("bilibili:BV1GJ411x7h7:20".into());
        assert!(commit(&mut c, "memory", "import:order", "原顺序", &[duplicate]).is_err());
        assert_eq!(ids(&c), vec![99, 1, 20, 3, 4]);
        assert_eq!(
            c.query_row(
                "SELECT document FROM playlist_import_archives WHERE playlist_id='import:order'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            before
        );
        c.execute_batch("CREATE TRIGGER fail_archive BEFORE UPDATE ON playlist_import_archives BEGIN SELECT RAISE(ABORT,'disk write failed'); END;").unwrap();
        let mut replacement = ordered_entry(30, Some(1));
        replacement.replace_track_id = Some("bilibili:BV1GJ411x7h7:20".into());
        assert!(commit(&mut c, "memory", "import:order", "原顺序", &[replacement]).is_err());
        assert_eq!(ids(&c), vec![99, 1, 20, 3, 4]);
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM source_items WHERE cid=30", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap(),
            0
        );
        assert_eq!(
            c.query_row(
                "SELECT document FROM playlist_import_archives WHERE playlist_id='import:order'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            before
        );
    }
    #[test]
    fn recognizes_all_supported_platforms_and_rejects_lookalike_hosts() {
        for (url, source, id) in [
            (
                "https://m.kugou.com/songlist/gcid_abc123/?uid=1",
                "kugou",
                "gcid_abc123",
            ),
            (
                "https://www.kugou.com/yy/special/single/123.html",
                "kugou",
                "special:123",
            ),
            (
                "https://m.kuwo.cn/h5app/playlist/123?t=qqfriend",
                "kuwo",
                "123",
            ),
            (
                "https://h5.nf.migu.cn/app/v4/p/share/playlist/index.html?id=123",
                "migu",
                "123",
            ),
            (
                "https://music.migu.cn/v5/#/playlist?playlistId=456",
                "migu",
                "456",
            ),
        ] {
            let parsed = parse_input(url).unwrap();
            assert_eq!(playlist_id(&parsed), Some((source, id.to_owned())));
        }
        for url in [
            "https://m.kugou.com.evil.test/songlist/gcid_a/",
            "https://127.0.0.1/playlist/1",
            "https://evil.test/?url=https://m.kuwo.cn/playlist/1",
        ] {
            assert!(parse_input(url).is_err());
        }
    }
    #[tokio::test]
    #[ignore = "live public music playlist metadata"]
    async fn live_additional_playlist_metadata() {
        for url in [
            "https://m.kugou.com/songlist/gcid_3zdr3tr0z1z024/",
            "https://www.kuwo.cn/playlist_detail/2858093057",
            "https://h5.nf.migu.cn/app/v4/p/share/playlist/index.html?id=184187437",
        ] {
            let playlist = read_playlist(url).await.unwrap();
            println!(
                "{}: {} readable / {} reported, {} unavailable",
                playlist.source,
                playlist.songs.len(),
                playlist.reported_count,
                playlist.unavailable_count
            );
            assert!(!playlist.songs.is_empty());
            if playlist.source != "kuwo" {
                assert!(
                    playlist.songs.len() > 100,
                    "must read beyond the first page"
                );
            }
            assert_eq!(
                playlist.songs.len() + playlist.unavailable_count,
                playlist.reported_count
            );
        }
    }
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
    fn qq_song_keeps_version_title_original_alias_and_splits_artist() {
        let instrumental = qq_song(&serde_json::json!({
            "songid": 394240052,
            "songname": "浮光 (Inst.)",
            "songorig": "浮光",
            "interval": 258,
            "albumname": "",
            "singer": [{"name": "纯音乐"}]
        }))
        .unwrap();
        assert_eq!(instrumental.title, "浮光 (Inst.)");
        assert_eq!(instrumental.aliases, ["浮光"]);
        assert_eq!(instrumental.artists, ["纯音乐"]);
        assert!(instrumental.album.is_none());
        let artist = qq_song(&serde_json::json!({
            "songid": 233812615,
            "songname": "走るということ",
            "songorig": "走るということ",
            "interval": 148,
            "singer": [{"name": "林友树 (林ゆうき)"}]
        }))
        .unwrap();
        assert!(artist.aliases.is_empty());
        assert_eq!(artist.artists, ["林友树", "林ゆうき"]);
        let orchestral = qq_song(&serde_json::json!({
            "songid": 330267406,
            "songname": "千秋 (Orch)",
            "songorig": "千秋",
            "interval": 198,
            "singer": [{"name": "古剑奇谭三"}]
        }))
        .unwrap();
        assert_eq!(orchestral.aliases, ["千秋"]);
        assert_eq!(orchestral.artists, ["古剑奇谭三"]);
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
                source_title_context: None,
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
            original_position: None,
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
