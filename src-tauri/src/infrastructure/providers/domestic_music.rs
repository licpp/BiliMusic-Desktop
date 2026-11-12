//! Cookie-free metadata and lyric adapters. Never use the Bilibili HTTP client here.
use base64::{Engine, engine::general_purpose::STANDARD};
use reqwest::Client;
use serde_json::{Value, json};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum MusicError {
    #[error("音乐资料服务连接失败，请稍后重试")]
    Network(#[from] reqwest::Error),
    #[error("音乐资料服务暂时不可用，请稍后重试或切换来源")]
    Unavailable,
}

#[derive(Debug)]
pub struct MusicSong {
    pub id: i64,
    pub name: String,
    pub artist: String,
    pub album: Option<String>,
    pub cover: Option<String>,
    pub duration: f64,
}

#[derive(Debug, Default)]
pub struct MusicLyrics {
    pub original: Option<String>,
    pub translated: Option<String>,
    pub romanized: Option<String>,
}

fn text(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .map(str::to_owned)
}
fn artists(value: &Value) -> String {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| text(&v["name"]))
        .collect::<Vec<_>>()
        .join(" / ")
}
fn netease_song(v: &Value) -> Option<MusicSong> {
    let id = v["id"].as_i64().filter(|id| *id > 0)?;
    let album = if v["al"].is_object() {
        &v["al"]
    } else {
        &v["album"]
    };
    Some(MusicSong {
        id,
        name: text(&v["name"])?,
        artist: artists(if v["ar"].is_array() {
            &v["ar"]
        } else {
            &v["artists"]
        }),
        album: text(&album["name"]),
        cover: text(&album["picUrl"]).map(|s| s.replacen("http://", "https://", 1)),
        duration: v["dt"]
            .as_f64()
            .or_else(|| v["duration"].as_f64())
            .unwrap_or(0.0)
            / 1000.0,
    })
}
pub async fn search_netease(
    client: &Client,
    origin: &str,
    keyword: &str,
    limit: usize,
    artwork: bool,
) -> Result<Vec<MusicSong>, MusicError> {
    let data: Value = client
        .get(format!("{origin}/api/search/get/web"))
        .query(&[("s", keyword), ("type", "1"), ("limit", &limit.to_string())])
        .header("Referer", "https://music.163.com/")
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    if data["code"].as_i64() != Some(200) {
        return Err(MusicError::Unavailable);
    }
    let mut songs: Vec<_> = data["result"]["songs"]
        .as_array()
        .into_iter()
        .flatten()
        .take(limit)
        .filter_map(netease_song)
        .collect();
    if artwork && songs.iter().any(|s| s.cover.is_none()) {
        // Search can omit artwork. One detail request fills the whole result page.
        let ids = Value::Array(
            songs
                .iter()
                .filter(|s| s.cover.is_none())
                .map(|s| json!({"id":s.id}))
                .collect(),
        )
        .to_string();
        if let Ok(response) = client
            .get(format!("{origin}/api/v3/song/detail"))
            .query(&[("c", ids)])
            .header("Referer", "https://music.163.com/")
            .send()
            .await
        {
            if let Ok(data) = response.json::<Value>().await {
                for song in data["songs"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(netease_song)
                {
                    if let Some(item) = songs.iter_mut().find(|s| s.id == song.id) {
                        item.cover = song.cover;
                        item.album = song.album;
                    }
                }
            }
        }
    }
    Ok(songs)
}
pub async fn netease_lyrics(
    client: &Client,
    origin: &str,
    id: i64,
) -> Result<MusicLyrics, MusicError> {
    let data: Value = client
        .get(format!("{origin}/api/song/lyric"))
        .query(&[
            ("id", id.to_string()),
            ("lv", "-1".into()),
            ("kv", "-1".into()),
            ("tv", "-1".into()),
            ("rv", "-1".into()),
        ])
        .header("Referer", "https://music.163.com/")
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    if data["code"].as_i64() != Some(200) {
        return Err(MusicError::Unavailable);
    }
    Ok(MusicLyrics {
        original: text(&data["lrc"]["lyric"]),
        translated: text(&data["tlyric"]["lyric"]),
        romanized: text(&data["romalrc"]["lyric"]),
    })
}
pub async fn search_qq(
    client: &Client,
    origin: &str,
    keyword: &str,
    limit: usize,
) -> Result<Vec<MusicSong>, MusicError> {
    let module = "music.search.SearchCgiService";
    let request = json!({"comm":{"ct":"19","cv":"2151","uin":"0"},"music.search.SearchCgiService":{"module":module,"method":"DoSearchForQQMusicDesktop",
        "param":{"grp":1,"num_per_page":limit,"page_num":1,"query":keyword,"search_type":0,"remoteplace":"txt.newclient.top"}}});
    let body = request.to_string();
    let data: Value = client
        .post(format!("{origin}/cgi-bin/musics.fcg"))
        .query(&[("sign", qq_search_signature(&body))])
        .header("Referer", "https://y.qq.com/")
        .header("User-Agent", "QQMusic 14090508(android 12)")
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    if data["code"].as_i64() != Some(0) || data[module]["code"].as_i64() != Some(0) {
        return Err(MusicError::Unavailable);
    }
    Ok(data[module]["data"]["body"]["song"]["list"]
        .as_array()
        .into_iter()
        .flatten()
        .take(limit)
        .filter_map(|v| {
            let id = v["songid"]
                .as_i64()
                .or_else(|| v["id"].as_i64())
                .filter(|id| *id > 0)?;
            let mid = v["albummid"]
                .as_str()
                .or_else(|| v["album"]["mid"].as_str())
                .unwrap_or("");
            let cover = (!mid.is_empty()
                && mid.len() < 100
                && mid.bytes().all(|c| c.is_ascii_alphanumeric()))
            .then(|| format!("https://y.gtimg.cn/music/photo_new/T002R500x500M000{mid}.jpg"));
            Some(MusicSong {
                id,
                name: text(&v["songname"]).or_else(|| text(&v["name"]))?,
                artist: artists(&v["singer"]),
                album: text(&v["albumname"]).or_else(|| text(&v["album"]["name"])),
                cover,
                duration: v["interval"].as_f64().unwrap_or(0.0),
            })
        })
        .collect())
}

// QQ's public zzc request checksum. Hash exactly the UTF-8 bytes sent as the body.
// Contract independently verified against the current QQ music search service.
fn qq_search_signature(body: &str) -> String {
    let digest = ring::digest::digest(&ring::digest::SHA1_FOR_LEGACY_USE_ONLY, body.as_bytes());
    let bytes = digest.as_ref();
    let hex = bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
    let pick = |indices: &[usize]| {
        indices
            .iter()
            .filter_map(|i| hex.as_bytes().get(*i))
            .map(|v| *v as char)
            .collect::<String>()
    };
    let mask = [
        89, 39, 179, 150, 218, 82, 58, 252, 177, 52, 186, 123, 120, 64, 242, 133, 143, 161, 121,
        179,
    ];
    let mixed: Vec<_> = bytes.iter().zip(mask).map(|(a, b)| a ^ b).collect();
    let middle = STANDARD.encode(mixed).replace(['/', '+', '=', '\\'], "");
    format!(
        "zzc{}{}{}",
        pick(&[23, 14, 6, 36, 16, 40, 7, 19]),
        middle,
        pick(&[16, 1, 32, 12, 19, 27, 8, 5])
    )
    .to_lowercase()
}

fn decoded_lyric(value: &Value) -> Option<String> {
    let source = value.as_str()?.trim();
    if source.is_empty() || source.len() > 2_000_000 {
        return None;
    }
    let raw = if source.starts_with('[') || source.starts_with('<') {
        source.to_owned()
    } else if source.len().is_multiple_of(16) && source.bytes().all(|v| v.is_ascii_hexdigit()) {
        super::qrc_codec::decrypt(source).ok()?
    } else {
        String::from_utf8(STANDARD.decode(source).ok()?).ok()?
    };
    let raw = normalize_qq_lyric(&raw)?;
    // Never pass encrypted QRC/hex or arbitrary response bodies through as lyrics.
    if !raw.lines().any(|line| line.trim_start().starts_with('[')) {
        return None;
    }
    Some(
        raw.replace("&#58;", ":")
            .replace("&#10;", "\n")
            .replace("&#13;", "")
            .replace("&quot;", "\"")
            .replace("&apos;", "'")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&amp;", "&"),
    )
}

fn normalize_qq_lyric(raw: &str) -> Option<String> {
    let mut content = raw.to_owned();
    if raw.trim_start().starts_with('<') {
        let mut reader = quick_xml::Reader::from_str(raw);
        let mut found = None;
        loop {
            match reader.read_event() {
                Ok(
                    quick_xml::events::Event::Start(node) | quick_xml::events::Event::Empty(node),
                ) => {
                    for attribute in node.attributes().flatten() {
                        if attribute.key.as_ref() == b"LyricContent" {
                            found = attribute
                                .decode_and_unescape_value(reader.decoder())
                                .ok()
                                .map(|s| s.into_owned());
                            break;
                        }
                    }
                    if found.is_some() {
                        break;
                    }
                }
                Ok(quick_xml::events::Event::Eof) | Err(_) => break,
                _ => {}
            }
        }
        content = found?;
    }
    let mut lines = vec![];
    for line in content.lines() {
        let line = line.trim();
        let Some((stamp, body)) = line.strip_prefix('[').and_then(|v| v.split_once(']')) else {
            continue;
        };
        if stamp.contains(':') {
            lines.push(line.to_owned());
            continue;
        }
        let Some((start, duration)) = stamp.split_once(',') else {
            continue;
        };
        let Ok(ms) = start.parse::<u64>() else {
            continue;
        };
        if duration.parse::<u64>().is_err() {
            continue;
        }
        let mut tail = body;
        let mut text = String::new();
        while let Some(begin) = tail.find('(') {
            text.push_str(&tail[..begin]);
            tail = &tail[begin + 1..];
            if let Some(end) = tail.find(')') {
                let values: Vec<_> = tail[..end].split(',').collect();
                if (2..=3).contains(&values.len())
                    && values.iter().all(|v| v.parse::<u64>().is_ok())
                {
                    tail = &tail[end + 1..];
                    continue;
                }
            }
            text.push('(');
        }
        text.push_str(tail);
        if !text.trim().is_empty() {
            lines.push(format!(
                "[{:02}:{:02}.{:03}]{}",
                ms / 60000,
                (ms / 1000) % 60,
                ms % 1000,
                text.trim()
            ))
        }
    }
    (!lines.is_empty()).then(|| lines.join("\n"))
}
pub async fn qq_lyrics(client: &Client, origin: &str, id: i64) -> Result<MusicLyrics, MusicError> {
    let request = json!({"comm":{"ct":19,"cv":1859,"uin":0},"req":{"module":"music.musichallSong.PlayLyricInfo","method":"GetPlayLyricInfo",
        "param":{"songID":id,"crypt":0,"qrc":0,"roma":1,"trans":1,"type":-1,"ct":19,"cv":1873}}});
    let data: Value = client
        .get(format!("{origin}/cgi-bin/musicu.fcg"))
        .query(&[("data", request.to_string())])
        .header("Referer", "https://y.qq.com/")
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    if data["code"].as_i64() != Some(0) || data["req"]["code"].as_i64() != Some(0) {
        return Err(MusicError::Unavailable);
    }
    let v = &data["req"]["data"];
    Ok(MusicLyrics {
        original: decoded_lyric(&v["lyric"]),
        translated: decoded_lyric(&v["trans"]),
        romanized: decoded_lyric(&v["roma"]),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn both_netease_song_shapes_and_qq_text_encoding_are_supported() {
        let song=netease_song(&json!({"id":42,"name":"曲名","dt":256000,"ar":[{"name":"歌手"}],"al":{"name":"专辑","picUrl":"http://p1.music.126.net/cover.jpg"}})).unwrap();
        assert_eq!(song.duration, 256.0);
        assert_eq!(
            song.cover.as_deref(),
            Some("https://p1.music.126.net/cover.jpg")
        );
        let lrc = "[00:01.00]test";
        assert_eq!(
            decoded_lyric(&json!(STANDARD.encode(lrc))),
            Some(lrc.into())
        );
        assert!(decoded_lyric(&json!("ABCDEF0123456789")).is_none());
        assert_eq!(
            normalize_qq_lyric(
                "<Lyric_1 LyricContent=\"[1000,2000]hello(1000,500) (live)(1500,500)\"/>"
            ),
            Some("[00:01.000]hello (live)".into())
        );
    }
}
