use super::*;
use futures_util::StreamExt;
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
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Season {
    pub summary: SeasonSummary,
    pub tracks: Vec<SeasonTrack>,
    pub unavailable: usize,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeasonTrack {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub play_count: Option<u64>,
    pub bvid: String,
    pub aid: i64,
    pub cid: i64,
    pub title: String,
    pub cover_url: String,
    pub duration_seconds: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parts: Option<Vec<VideoPart>>,
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
pub(super) type PageEntry = Arc<tokio::sync::OnceCell<(Instant, Vec<VideoPart>)>>;
const CATALOG_TTL: Duration = Duration::from_secs(300);

pub(super) fn normalize_pages(
    mut pages: Vec<PageData>,
    title: &str,
    cover: &str,
) -> Vec<VideoPart> {
    pages.sort_by_key(|part| part.page);
    let mut cids = std::collections::HashSet::new();
    if pages.len() > 2000
        || pages.iter().enumerate().any(|(index, part)| {
            part.page as usize != index + 1 || part.cid <= 0 || !cids.insert(part.cid)
        })
    {
        return Vec::new();
    }
    let single = pages.len() == 1 && !title.is_empty();
    pages
        .into_iter()
        .map(|part| {
            let first_frame_url = normalize_url(&part.first_frame);
            VideoPart {
                cid: part.cid,
                page: part.page,
                duration_seconds: part.duration,
                title: if single || part.part.trim().is_empty() {
                    title.to_owned()
                } else {
                    part.part
                },
                cover_url: if cover.is_empty() {
                    first_frame_url.clone()
                } else {
                    cover.to_owned()
                },
                first_frame_url,
            }
        })
        .collect()
}

pub(super) fn season_summary(raw: &Value, owner: &Owner) -> Option<SeasonSummary> {
    let id = raw["id"].as_i64().filter(|id| *id > 0)?;
    Some(SeasonSummary {
        id,
        uploader_id: raw["mid"]
            .as_i64()
            .filter(|mid| *mid > 0)
            .unwrap_or(owner.mid),
        title: text(raw, "title"),
        cover_url: normalize_url(&text(raw, "cover")),
        uploader_name: owner.name.clone(),
    })
}

fn episodes(raw: &Value) -> impl Iterator<Item = &Value> {
    raw["sections"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|section| section["episodes"].as_array().into_iter().flatten())
}

fn season_member(archive: &Value, episode: Option<&Value>) -> SeasonTrack {
    let bvid = text(archive, "bvid");
    let arc = episode.map(|ep| &ep["arc"]).unwrap_or(&Value::Null);
    let title = [
        text(archive, "title"),
        text(arc, "title"),
        episode.map(|ep| text(ep, "title")).unwrap_or_default(),
    ]
    .into_iter()
    .find(|title| !title.is_empty())
    .unwrap_or_default();
    let cover = normalize_url(
        &[text(archive, "pic"), text(arc, "pic")]
            .into_iter()
            .find(|cover| !cover.is_empty())
            .unwrap_or_default(),
    );
    let hint = episode
        .map(|ep| number(ep, "cid"))
        .unwrap_or_else(|| number(archive, "cid"))
        .max(0);
    let parts = episode.and_then(|ep| {
        let rows: Vec<PageData> = serde_json::from_value(ep["pages"].clone()).ok()?;
        let pages = normalize_pages(rows, &title, &cover);
        let first = pages.first()?;
        (hint == 0 || hint == first.cid).then_some(pages)
    });
    SeasonTrack {
        play_count: archive["stat"]["view"]
            .as_u64()
            .or_else(|| arc["stat"]["view"].as_u64())
            .or_else(|| archive["play"].as_u64()),
        bvid,
        aid: number(archive, "aid")
            .max(number(arc, "aid"))
            .max(episode.map(|ep| number(ep, "aid")).unwrap_or(0)),
        cid: parts.as_ref().map(|p| p[0].cid).unwrap_or(hint),
        title,
        cover_url: cover,
        duration_seconds: archive["duration"]
            .as_u64()
            .or_else(|| arc["duration"].as_u64())
            .unwrap_or(0),
        parts,
    }
}

pub(super) fn complete_season(raw: &Value, summary: &SeasonSummary, seed: &str) -> Option<Season> {
    let total = raw["ep_count"]
        .as_u64()
        .filter(|count| (1..=2000).contains(count))? as usize;
    let tracks: Vec<_> = episodes(raw)
        .map(|episode| season_member(episode, Some(episode)))
        .collect();
    let mut seen = std::collections::HashSet::new();
    if tracks.len() != total
        || !tracks.iter().any(|track| track.bvid == seed)
        || tracks.iter().any(|track| {
            track.bvid.is_empty()
                || track.aid <= 0
                || track.title.is_empty()
                || track.parts.is_none()
                || !seen.insert(&track.bvid)
        })
    {
        return None;
    }
    Some(Season {
        summary: summary.clone(),
        tracks,
        unavailable: 0,
    })
}

impl BilibiliProvider {
    pub(super) async fn remember_pages(&self, epoch: u64, bvid: &str, parts: Vec<VideoPart>) {
        if parts.is_empty() {
            return;
        }
        let mut cache = self.pages.write().await;
        if self.catalog_epoch.load(Ordering::Relaxed) != epoch {
            return;
        }
        if cache.len() >= 512 {
            cache.retain(|_, cell| {
                cell.get()
                    .is_none_or(|(time, _)| time.elapsed() < CATALOG_TTL)
            });
            if cache.len() >= 512 {
                if let Some(key) = cache
                    .iter()
                    .filter_map(|(key, cell)| cell.get().map(|(time, _)| (key, time)))
                    .min_by_key(|(_, time)| *time)
                    .map(|(key, _)| key.clone())
                {
                    cache.remove(&key);
                }
            }
        }
        cache.insert(
            (epoch, bvid.to_owned()),
            Arc::new(tokio::sync::OnceCell::new_with(Some((
                Instant::now(),
                parts,
            )))),
        );
    }

    pub(super) async fn remember_season(&self, epoch: u64, season: Season) {
        let mut cache = self.seasons.write().await;
        if self.catalog_epoch.load(Ordering::Relaxed) != epoch {
            return;
        }
        if cache.len() >= 8 {
            if let Some(key) = cache
                .iter()
                .min_by_key(|(_, (time, _))| *time)
                .map(|(key, _)| *key)
            {
                cache.remove(&key);
            }
        }
        cache.insert(
            (epoch, season.summary.uploader_id, season.summary.id),
            (Instant::now(), season),
        );
    }

    pub async fn video_pagelist(&self, bvid: &str) -> Result<Vec<VideoPart>, ProviderError> {
        let epoch = self.catalog_epoch.load(Ordering::Relaxed);
        // A complete season already contains the same CID list.
        let embedded =
            self.seasons
                .read()
                .await
                .iter()
                .find_map(|((scope, _, _), (time, season))| {
                    if *scope != epoch || time.elapsed() >= CATALOG_TTL {
                        return None;
                    }
                    season
                        .tracks
                        .iter()
                        .find(|track| track.bvid == bvid)
                        .and_then(|track| track.parts.clone())
                });
        if let Some(parts) = embedded {
            return Ok(parts);
        }
        let key = (epoch, bvid.to_owned());
        let entry = {
            let mut cache = self.pages.write().await;
            if cache
                .get(&key)
                .and_then(|entry| entry.get())
                .is_some_and(|(time, _)| time.elapsed() >= CATALOG_TTL)
            {
                cache.remove(&key);
            }
            if cache.len() >= 512 && !cache.contains_key(&key) {
                if let Some(old) = cache
                    .iter()
                    .filter_map(|(key, cell)| cell.get().map(|(time, _)| (key, time)))
                    .min_by_key(|(_, time)| *time)
                    .map(|(key, _)| key.clone())
                {
                    cache.remove(&old);
                }
            }
            cache.entry(key.clone()).or_default().clone()
        };
        let result = entry
            .get_or_try_init(|| async {
                let _permit = self
                    .page_slots
                    .acquire()
                    .await
                    .expect("page semaphore remains open");
                if self.catalog_epoch.load(Ordering::Relaxed) != epoch {
                    return Err(ProviderError::Api {
                        code: -1,
                        message: "账号已切换".into(),
                    });
                }
                let mut url = self.api_url("/x/player/pagelist");
                url.query_pairs_mut().append_pair("bvid", bvid);
                let rows = tokio::time::timeout(
                    Duration::from_secs(5),
                    self.get_data::<Vec<PageData>>(url),
                )
                .await
                .map_err(|_| ProviderError::Api {
                    code: -1,
                    message: "获取分 P 超时".into(),
                })??;
                let pages = normalize_pages(rows, "", "");
                if pages.is_empty() {
                    return Err(ProviderError::Api {
                        code: -1,
                        message: "暂无可用分 P".into(),
                    });
                }
                Ok((Instant::now(), pages))
            })
            .await;
        match result {
            Ok((_, pages)) => Ok(pages.clone()),
            Err(error) => {
                let mut cache = self.pages.write().await;
                if cache
                    .get(&key)
                    .is_some_and(|saved| Arc::ptr_eq(saved, &entry))
                {
                    cache.remove(&key);
                }
                Err(error)
            }
        }
    }

    pub async fn season(&self, mid: i64, id: i64, refresh: bool) -> Result<Season, ProviderError> {
        let epoch = self.catalog_epoch.load(Ordering::Relaxed);
        if !refresh {
            if let Some((time, season)) = self.seasons.read().await.get(&(epoch, mid, id)) {
                if time.elapsed() < CATALOG_TTL {
                    return Ok(season.clone());
                }
            }
        }
        let page_url = |page: u32| {
            let mut url = self.api_url("/x/polymer/web-space/seasons_archives_list");
            url.query_pairs_mut()
                .append_pair("mid", &mid.to_string())
                .append_pair("season_id", &id.to_string())
                .append_pair("page_num", &page.to_string())
                .append_pair("page_size", "100")
                .append_pair("sort_reverse", "false");
            url
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
        let seed = archives
            .first()
            .map(|archive| text(archive, "bvid"))
            .unwrap_or_default();
        let mut seed_detail = Value::Null;
        if !seed.is_empty() {
            let mut url = self.api_url("/x/web-interface/view");
            url.query_pairs_mut().append_pair("bvid", &seed);
            seed_detail = self.get_data(url).await.unwrap_or(Value::Null);
            summary.uploader_name = text(&seed_detail["owner"], "name");
        }
        let raw = &seed_detail["ugc_season"];
        let matching = number(raw, "id") == id;
        if matching && let Some(season) = complete_season(raw, &summary, &seed) {
            if season.tracks.len() as u64 == total
                && archives.iter().all(|archive| {
                    let bvid = text(archive, "bvid");
                    season.tracks.iter().any(|video| video.bvid == bvid)
                })
            {
                self.remember_season(epoch, season.clone()).await;
                return Ok(season);
            }
        }
        for page in 2..=(total.div_ceil(100) as u32) {
            let data: Value = self.get_data(page_url(page)).await?;
            archives.extend(data["archives"].as_array().into_iter().flatten().cloned());
        }
        let known: HashMap<_, _> = if matching {
            episodes(raw)
                .enumerate()
                .map(|(i, episode)| (text(episode, "bvid"), (i, episode)))
                .collect()
        } else {
            HashMap::new()
        };
        archives.sort_by_key(|archive| {
            known
                .get(&text(archive, "bvid"))
                .map_or(usize::MAX, |entry| entry.0)
        });
        let mut seen = std::collections::HashSet::new();
        let mut unavailable = 0;
        let tracks: Vec<_> = archives
            .iter()
            .filter_map(|archive| {
                let bvid = text(archive, "bvid");
                if bvid.is_empty() {
                    unavailable += 1;
                    return None;
                }
                seen.insert(bvid.clone())
                    .then(|| season_member(archive, known.get(&bvid).map(|entry| entry.1)))
            })
            .collect();
        if summary.cover_url.is_empty() || summary.cover_url.contains("viedeo_material_default") {
            if let Some(first) = tracks.first() {
                summary.cover_url = first.cover_url.clone();
            }
        }
        let season = Season {
            summary,
            tracks,
            unavailable,
        };
        self.remember_season(epoch, season.clone()).await;
        Ok(season)
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
        Ok(MediaOptions { audio, video })
    }
}

#[cfg(test)]
mod catalog_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn complete_snapshot_distinguishes_single_and_multi_part_videos() {
        let raw = json!({"ep_count":2,"sections":[{"episodes":[
            {"bvid":"BVsingle","aid":1,"cid":11,"arc":{"title":"Video title","videos":0},"pages":[{"cid":11,"page":1,"part":"upload filename","duration":20}]},
            {"bvid":"BVmulti","aid":2,"cid":21,"arc":{"title":"Second video","videos":0},"pages":[{"cid":21,"page":1,"part":"First","duration":20},{"cid":22,"page":2,"part":"Second","duration":21}]}
        ]}]});
        let summary = SeasonSummary {
            id: 1,
            uploader_id: 2,
            title: "Season".into(),
            cover_url: String::new(),
            uploader_name: String::new(),
        };
        let season = complete_season(&raw, &summary, "BVsingle").unwrap();
        let single = season.tracks[0].parts.as_ref().unwrap();
        assert_eq!(single.len(), 1);
        assert_eq!(single[0].title, "Video title");
        let multi = season.tracks[1].parts.as_ref().unwrap();
        assert_eq!(
            multi.iter().map(|page| page.cid).collect::<Vec<_>>(),
            [21, 22]
        );
        assert_eq!(multi[1].title, "Second");

        let mut partial = raw;
        partial["sections"][0]["episodes"][1]["pages"][0]["cid"] = json!(22);
        assert!(complete_season(&partial, &summary, "BVsingle").is_none());
        let damaged = &partial["sections"][0]["episodes"][1];
        assert!(season_member(damaged, Some(damaged)).parts.is_none());
    }
}
