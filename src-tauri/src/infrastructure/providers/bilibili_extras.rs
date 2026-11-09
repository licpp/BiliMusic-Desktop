use super::*;
use futures_util::{StreamExt, stream};
use serde_json::Value;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeasonSummary {
    pub id: i64,
    pub uploader_id: i64,
    pub title: String,
    pub cover_url: String,
    pub uploader_name: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Season {
    pub summary: SeasonSummary,
    pub tracks: Vec<SeasonTrack>,
    pub unavailable: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeasonTrack {
    pub bvid: String,
    pub aid: i64,
    pub cid: i64,
    pub title: String,
    pub cover_url: String,
    pub duration_seconds: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleChoice {
    pub language: String,
    pub label: String,
    pub ai: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleLine {
    pub time_ms: u64,
    pub end_time_ms: u64,
    pub text: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityOption {
    pub id: u32,
    pub label: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaOptions {
    pub audio: Vec<QualityOption>,
    pub video: Vec<QualityOption>,
}
fn text(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_default().to_owned()
}
fn number(value: &Value, key: &str) -> i64 {
    value[key].as_i64().unwrap_or_default()
}
impl BilibiliProvider {
    pub async fn season(&self, mid: i64, id: i64) -> Result<Season, ProviderError> {
        let page_url = |page: u32| {
            let mut u = self.api_url("/x/polymer/web-space/seasons_archives_list");
            u.query_pairs_mut()
                .append_pair("mid", &mid.to_string())
                .append_pair("season_id", &id.to_string())
                .append_pair("page_num", &page.to_string())
                .append_pair("page_size", "100")
                .append_pair("sort_reverse", "false");
            u
        };
        let first: Value = self.get_data(page_url(1)).await?;
        let total = first["page"]["total"].as_u64().unwrap_or(0);
        if total > 2000 {
            return Err(ProviderError::Api {
                code: -1,
                message: "暂时最多支持 2000 个视频的合集".into(),
            });
        }
        let meta = &first["meta"];
        let mut summary = SeasonSummary {
            id,
            uploader_id: mid,
            title: if text(meta, "title").is_empty() {
                text(meta, "name")
            } else {
                text(meta, "title")
            },
            cover_url: normalize_url(&text(meta, "cover")),
            uploader_name: String::new(),
        };
        let mut archives = first["archives"].as_array().cloned().unwrap_or_default();
        for page in 2..=(total.div_ceil(100) as u32) {
            let data: Value = self.get_data(page_url(page)).await?;
            archives.extend(data["archives"].as_array().cloned().unwrap_or_default());
        }
        let mut known = HashMap::new();
        let mut order = HashMap::new();
        if let Some(first) = archives.first() {
            let mut u = self.api_url("/x/web-interface/view");
            u.query_pairs_mut()
                .append_pair("bvid", &text(first, "bvid"));
            let d: Value = self.get_data(u).await.unwrap_or(Value::Null);
            summary.uploader_name = text(&d["owner"], "name");
            if number(&d["ugc_season"], "id") == id {
                for section in d["ugc_season"]["sections"].as_array().into_iter().flatten() {
                    for ep in section["episodes"].as_array().into_iter().flatten() {
                        let bvid = text(ep, "bvid");
                        let rank = order.len();
                        order.entry(bvid.clone()).or_insert(rank);
                        known.insert(bvid, ep.clone());
                    }
                }
            }
        }
        archives.sort_by_key(|a| order.get(&text(a, "bvid")).copied().unwrap_or(usize::MAX));
        let result = stream::iter(archives.into_iter().map(|a| {
            let ep = known.get(&text(&a, "bvid")).cloned();
            async move {
                let bvid = text(&a, "bvid");
                let mut cid = ep.as_ref().map(|e| number(e, "cid")).unwrap_or(0);
                if cid <= 0 {
                    let d = self.video_parts(&bvid).await?;
                    cid = d.parts.first().map(|p| p.cid).unwrap_or(0);
                }
                if cid <= 0 {
                    return Ok(None);
                }
                Ok::<_, ProviderError>(Some(SeasonTrack {
                    bvid,
                    aid: number(&a, "aid"),
                    cid,
                    title: ep
                        .as_ref()
                        .map(|e| text(e, "title"))
                        .filter(|s| !s.is_empty())
                        .unwrap_or_else(|| text(&a, "title")),
                    cover_url: normalize_url(&text(&a, "pic")),
                    duration_seconds: a["duration"].as_u64().unwrap_or(0),
                }))
            }
        }))
        .buffered(4)
        .collect::<Vec<_>>()
        .await;
        let mut tracks = Vec::new();
        let mut unavailable = 0;
        let mut last_error = None;
        let mut seen = std::collections::HashSet::new();
        for result in result {
            match result {
                Ok(Some(track)) => {
                    if seen.insert(track.bvid.clone()) {
                        tracks.push(track);
                    }
                }
                Ok(None) => unavailable += 1,
                Err(error) => {
                    last_error = Some(error);
                    unavailable += 1;
                }
            }
        }
        if tracks.is_empty() {
            if let Some(error) = last_error {
                return Err(error);
            }
        }
        if summary.cover_url.is_empty() || summary.cover_url.contains("viedeo_material_default") {
            if let Some(first) = tracks.first() {
                summary.cover_url = first.cover_url.clone();
            }
        }
        Ok(Season {
            summary,
            tracks,
            unavailable,
        })
    }

    async fn subtitle_data(&self, bvid: &str, cid: i64) -> Result<Value, ProviderError> {
        let mut url = self.api_url("/x/player/wbi/v2");
        url.query_pairs_mut()
            .append_pair("bvid", bvid)
            .append_pair("cid", &cid.to_string());
        self.get_data(url).await
    }
    pub async fn subtitles(
        &self,
        bvid: &str,
        cid: i64,
    ) -> Result<Vec<SubtitleChoice>, ProviderError> {
        let data = self.subtitle_data(bvid, cid).await?;
        Ok(data["subtitle"]["subtitles"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|s| SubtitleChoice {
                language: text(s, "lan"),
                label: text(s, "lan_doc"),
                ai: text(s, "lan").starts_with("ai-"),
            })
            .collect())
    }
    pub async fn subtitle_lines(
        &self,
        bvid: &str,
        cid: i64,
        language: &str,
    ) -> Result<Vec<SubtitleLine>, ProviderError> {
        let data = self.subtitle_data(bvid, cid).await?;
        let entry = data["subtitle"]["subtitles"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|s| s["lan"].as_str() == Some(language))
            .ok_or(ProviderError::Api {
                code: -1,
                message: "当前字幕不可用，请刷新字幕列表".into(),
            })?;
        let url = Url::parse(&normalize_url(&text(entry, "subtitle_url"))).map_err(|_| {
            ProviderError::Api {
                code: -1,
                message: "字幕地址无效".into(),
            }
        })?;
        let host = url.host_str().unwrap_or_default();
        if url.scheme() != "https"
            || !(host.ends_with(".hdslb.com") || host.ends_with(".bilibili.com"))
        {
            return Err(ProviderError::Api {
                code: -1,
                message: "不支持的字幕来源".into(),
            });
        }
        // Do not attach the Bilibili account cookie to the subtitle CDN.
        let response = self.client.get(url).send().await?.error_for_status()?;
        let mut body = response.bytes_stream();
        let mut bytes = Vec::new();
        while let Some(chunk) = body.next().await {
            bytes.extend_from_slice(&chunk?);
            if bytes.len() > 4 * 1024 * 1024 {
                return Err(ProviderError::Api {
                    code: -1,
                    message: "字幕文件过大".into(),
                });
            }
        }
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| ProviderError::Api {
            code: -1,
            message: "字幕文件无法解析".into(),
        })?;
        let mut lines = Vec::new();
        for s in value["body"].as_array().into_iter().flatten().take(20000) {
            let from = s["from"].as_f64().unwrap_or(-1.0);
            let to = s["to"].as_f64().unwrap_or(-1.0);
            let content = text(s, "content");
            if from.is_finite()
                && to.is_finite()
                && from >= 0.0
                && to >= from
                && !content.trim().is_empty()
                && content.len() <= 4096
            {
                lines.push(SubtitleLine {
                    time_ms: (from * 1000.0).round() as u64,
                    end_time_ms: (to * 1000.0).round() as u64,
                    text: content,
                });
            }
        }
        lines.sort_by_key(|s| s.time_ms);
        Ok(lines)
    }
    pub async fn media_options(&self, bvid: &str, cid: i64) -> Result<MediaOptions, ProviderError> {
        let dash = self.play_dash(bvid, cid, true).await?;
        let mut audio: Vec<_> = dash
            .audio
            .iter()
            .filter(|s| s.codecs.starts_with("mp4a"))
            .map(|s| QualityOption {
                id: s.id,
                label: format!(
                    "{} · 约 {} kbps",
                    match s.id {
                        30280 => "高品质",
                        30232 => "标准",
                        30216 => "流畅",
                        _ => "AAC",
                    },
                    s.bandwidth / 1000
                ),
            })
            .collect();
        audio.sort_by_key(|s| s.id);
        audio.dedup_by_key(|s| s.id);
        let mut video: Vec<_> = dash
            .video
            .iter()
            .filter(|s| {
                s.height > 0
                    && (s.codecs.starts_with("avc")
                        || (cfg!(target_os = "ios") && s.codecs.starts_with("hvc1")))
            })
            .map(|s| QualityOption {
                id: s.height,
                label: if s.height == 2160 {
                    "4K".into()
                } else {
                    format!("{}p", s.height)
                },
            })
            .collect();
        video.sort_by_key(|s| s.id);
        video.dedup_by_key(|s| s.id);
        self.remember_video_streams(bvid, cid, true, dash.video)
            .await;
        Ok(MediaOptions { audio, video })
    }
}
