use super::*;
use futures_util::StreamExt;
use serde_json::Value;

pub use crate::domain::source_title::SeasonSummary;
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Season {
    pub summary: SeasonSummary,
    pub tracks: Vec<SeasonTrack>,
    pub unavailable: usize,
    pub sections: Vec<SeasonSection>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeasonSection {
    pub id: String,
    pub title: String,
    pub bvids: Vec<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeasonTrack {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published_at: Option<u64>,
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
    pub language_key: String,
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
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoChapter {
    pub start_ms: u64,
    pub end_ms: u64,
    pub title: String,
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
pub(super) type PlayerMetadataEntry = Arc<tokio::sync::OnceCell<(Instant, Arc<Value>)>>;
const PLAYER_METADATA_TTL: Duration = Duration::from_secs(120);
const PLAYER_METADATA_CACHE_LIMIT: usize = 64;

fn parse_video_chapters(data: &Value) -> Result<Vec<VideoChapter>, ProviderError> {
    let rows = match data.get("view_points") {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Array(rows)) => rows,
        Some(_) => return Err(ProviderError::UnexpectedResponse),
    };
    let mut chapters: Vec<_> = rows
        .iter()
        .filter_map(|row| {
            let milliseconds = |key| {
                let seconds = row[key].as_f64()?;
                let ms = (seconds * 1000.0).round();
                (seconds >= 0.0 && ms < (1_u64 << 53) as f64).then_some(ms as u64)
            };
            let start_ms = milliseconds("from")?;
            let end_ms = milliseconds("to")?;
            let title = row["content"].as_str()?.trim();
            (end_ms > start_ms && !title.is_empty()).then(|| VideoChapter {
                start_ms,
                end_ms,
                title: title.to_owned(),
            })
        })
        .collect();
    if chapters.is_empty() && !rows.is_empty() {
        return Err(ProviderError::UnexpectedResponse);
    }
    chapters.sort_by_key(|chapter| chapter.start_ms);
    chapters.dedup_by_key(|chapter| chapter.start_ms);
    Ok(chapters)
}

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

// Section order and episode order belong to the uploader, not publication time.
// Keep membership separate from videos so multi-P expansion cannot lose it.
fn season_sections(raw: &Value, tracks: &[SeasonTrack]) -> Vec<SeasonSection> {
    let available: std::collections::HashSet<_> = tracks.iter().map(|t| t.bvid.as_str()).collect();
    let mut ids = std::collections::HashSet::new();
    raw["sections"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .map(|(index, section)| {
            let mut id = section["id"]
                .as_i64()
                .filter(|id| *id > 0)
                .map(|id| id.to_string())
                .unwrap_or_else(|| format!("section-{index}"));
            if !ids.insert(id.clone()) {
                id = format!("{id}-{index}");
                ids.insert(id.clone());
            }
            let title = text(section, "title");
            let mut seen = std::collections::HashSet::new();
            let bvids = section["episodes"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|episode| text(episode, "bvid"))
                .filter(|bvid| available.contains(bvid.as_str()) && seen.insert(bvid.clone()))
                .collect();
            SeasonSection {
                id,
                title: if title.trim().is_empty() {
                    "默认分类".into()
                } else {
                    title
                },
                bvids,
            }
        })
        .collect()
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
        published_at: archive["pubdate"]
            .as_u64()
            .filter(|date| *date > 0)
            .or_else(|| arc["pubdate"].as_u64().filter(|date| *date > 0)),
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

fn paged_season_tracks(mut archives: Vec<Value>, raw: Option<&Value>) -> (Vec<SeasonTrack>, usize) {
    let known: HashMap<_, _> = if let Some(raw) = raw {
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
    (tracks, unavailable)
}

pub(super) fn usable_season_cover(cover: &str) -> bool {
    !cover.trim().is_empty() && !cover.contains("viedeo_material_default")
}

pub(super) fn first_archive_cover(archives: &Value) -> Option<&str> {
    archives
        .as_array()?
        .iter()
        .filter_map(|archive| archive["pic"].as_str())
        .find(|cover| usable_season_cover(cover))
}

fn season_cover(mut summary: SeasonSummary, tracks: &[SeasonTrack]) -> SeasonSummary {
    if !usable_season_cover(&summary.cover_url)
        && let Some(track) = tracks
            .iter()
            .find(|track| usable_season_cover(&track.cover_url))
    {
        summary.cover_url = track.cover_url.clone();
    }
    summary
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
        summary: season_cover(summary.clone(), &tracks),
        sections: season_sections(raw, &tracks),
        tracks,
        unavailable: 0,
    })
}

fn parse_subtitle_lines(value: &Value) -> Vec<SubtitleLine> {
    let mut lines = Vec::new();
    for s in value["body"].as_array().into_iter().flatten() {
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
    lines
}

fn subtitle_language_key(language: &str) -> String {
    let tag = language.trim().to_ascii_lowercase();
    let tag = tag.strip_prefix("ai-").unwrap_or(&tag);
    let primary = if tag == "chi-yue" {
        "yue"
    } else {
        tag.split(['-', '_']).next().unwrap_or_default()
    };
    match primary {
        "cn" | "cmn" | "zho" | "chi" => "zh",
        "eng" => "en",
        "jp" | "jpn" => "ja",
        "kr" | "kor" => "ko",
        "iw" => "he",
        "in" => "id",
        other => other,
    }
    .to_string()
}

#[cfg(any(target_os = "android", target_os = "ios", target_env = "ohos", test))]
fn preferred_subtitle_entry<'a>(data: &'a Value, preferred: Option<&str>) -> Option<&'a Value> {
    let preferred_key = preferred.map(subtitle_language_key);
    let preferred_ai = preferred.is_some_and(|tag| tag.starts_with("ai-"));
    data["subtitle"]["subtitles"]
        .as_array()?
        .iter()
        .filter_map(|entry| {
            let language = entry["lan"]
                .as_str()
                .filter(|language| !language.is_empty())?;
            Some((entry, language))
        })
        .min_by_key(|(_, language)| {
            let ai = language.starts_with("ai-");
            if preferred == Some(*language) {
                0
            } else if preferred_key
                .as_ref()
                .is_some_and(|key| !key.is_empty() && *key == subtitle_language_key(language))
            {
                if ai == preferred_ai { 1 } else { 2 }
            } else if ai {
                3
            } else {
                4
            }
        })
        .map(|(entry, _)| entry)
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
        self.video_pagelist_with_priority(bvid, RequestPriority::Foreground)
            .await
    }

    pub async fn video_pagelist_with_priority(
        &self,
        bvid: &str,
        priority: RequestPriority,
    ) -> Result<Vec<VideoPart>, ProviderError> {
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
                let _permit = self.foreground_catalog_slot(priority).await;
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
                    self.get_data_with_priority::<Vec<PageData>>(url, priority),
                )
                .await
                .map_err(|_| ProviderError::Api {
                    code: -1,
                    message: "获取分 P 超时".into(),
                })?;
                let rows = match rows {
                    Err(error @ ProviderError::Api { code: -404, .. }) => {
                        match tokio::time::timeout(
                            Duration::from_secs(3),
                            self.video_detail_with_priority(bvid, priority),
                        )
                        .await
                        {
                            Ok(Err(confirmed @ ProviderError::Api { code: 62002, .. })) => {
                                return Err(confirmed);
                            }
                            Ok(Err(restricted)) if restricted.is_request_restricted() => {
                                return Err(restricted);
                            }
                            Ok(Ok(detail)) => detail.pages,
                            _ => return Err(error),
                        }
                    }
                    result => result?,
                };
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

    fn season_page_url(&self, mid: i64, id: i64, page: u32, size: &str) -> Url {
        let mut url = self.api_url("/x/polymer/web-space/seasons_archives_list");
        url.query_pairs_mut()
            .append_pair("mid", &mid.to_string())
            .append_pair("season_id", &id.to_string())
            .append_pair("page_num", &page.to_string())
            .append_pair("page_size", size)
            .append_pair("sort_reverse", "false");
        url
    }

    pub async fn season_preview_cover(&self, mid: i64, id: i64) -> Result<String, ProviderError> {
        let epoch = self.catalog_epoch.load(Ordering::Relaxed);
        if let Some((time, season)) = self.seasons.read().await.get(&(epoch, mid, id))
            && time.elapsed() < CATALOG_TTL
        {
            return Ok(season.summary.cover_url.clone());
        }
        let first: Value = self
            .get_data_with_priority(
                self.season_page_url(mid, id, 1, "12"),
                RequestPriority::Background,
            )
            .await?;
        let cover = first["meta"]["cover"]
            .as_str()
            .filter(|cover| usable_season_cover(cover))
            .or_else(|| first_archive_cover(&first["archives"]));
        Ok(cover.map(normalize_url).unwrap_or_default())
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
        let page_url = |page| self.season_page_url(mid, id, page, "100");
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
        let (tracks, unavailable) = paged_season_tracks(archives, matching.then_some(raw));
        let season = Season {
            summary: season_cover(summary, &tracks),
            sections: if matching {
                season_sections(raw, &tracks)
            } else {
                Vec::new()
            },
            tracks,
            unavailable,
        };
        self.remember_season(epoch, season.clone()).await;
        Ok(season)
    }

    async fn player_metadata(&self, bvid: &str, cid: i64) -> Result<Arc<Value>, ProviderError> {
        let epoch = self.catalog_epoch.load(Ordering::Relaxed);
        let key = (epoch, bvid.to_owned(), cid);
        let entry = {
            let mut cache = self.player_metadata.write().await;
            self.check_request_epoch(epoch)?;
            if cache
                .get(&key)
                .and_then(|entry| entry.get())
                .is_some_and(|(at, _)| at.elapsed() >= PLAYER_METADATA_TTL)
            {
                cache.remove(&key);
            }
            if cache.len() >= PLAYER_METADATA_CACHE_LIMIT && !cache.contains_key(&key) {
                let oldest = cache
                    .iter()
                    .filter_map(|(key, entry)| entry.get().map(|(at, _)| (key, *at)))
                    .min_by_key(|(_, at)| *at)
                    .map(|(key, _)| key.clone());
                if let Some(oldest) = oldest {
                    cache.remove(&oldest);
                }
            }
            cache.entry(key.clone()).or_default().clone()
        };
        let result = entry
            .get_or_try_init(|| async {
                self.check_request_epoch(epoch)?;
                let mut url = self.api_url("/x/player/wbi/v2");
                url.query_pairs_mut()
                    .append_pair("bvid", bvid)
                    .append_pair("cid", &cid.to_string());
                let data: Value = self.get_data(url).await?;
                self.check_request_epoch(epoch)?;
                if !data.is_object() {
                    return Err(ProviderError::UnexpectedResponse);
                }
                Ok((Instant::now(), Arc::new(data)))
            })
            .await;
        self.check_request_epoch(epoch)?;
        match result {
            Ok((_, data)) => Ok(data.clone()),
            Err(error) => {
                let mut cache = self.player_metadata.write().await;
                if cache
                    .get(&key)
                    .is_some_and(|cached| Arc::ptr_eq(cached, &entry))
                    && Arc::strong_count(&entry) == 2
                {
                    cache.remove(&key);
                }
                self.check_request_epoch(epoch)?;
                Err(error)
            }
        }
    }
    pub async fn video_chapters(
        &self,
        bvid: &str,
        cid: i64,
    ) -> Result<Vec<VideoChapter>, ProviderError> {
        parse_video_chapters(self.player_metadata(bvid, cid).await?.as_ref())
    }
    pub async fn subtitles(
        &self,
        bvid: &str,
        cid: i64,
    ) -> Result<Vec<SubtitleChoice>, ProviderError> {
        let data = self.player_metadata(bvid, cid).await?;
        Ok(data["subtitle"]["subtitles"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|s| {
                let language = text(s, "lan");
                SubtitleChoice {
                    language_key: subtitle_language_key(&language),
                    ai: language.starts_with("ai-"),
                    label: text(s, "lan_doc"),
                    language,
                }
            })
            .collect())
    }
    pub async fn subtitle_lines(
        &self,
        bvid: &str,
        cid: i64,
        language: &str,
    ) -> Result<Vec<SubtitleLine>, ProviderError> {
        let data = self.player_metadata(bvid, cid).await?;
        let entry = data["subtitle"]["subtitles"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|s| s["lan"].as_str() == Some(language))
            .ok_or(ProviderError::Api {
                code: -1,
                message: "当前字幕不可用，请刷新字幕列表".into(),
            })?;
        self.subtitle_entry_lines(entry).await
    }
    #[cfg(any(target_os = "android", target_os = "ios", target_env = "ohos"))]
    pub async fn preferred_subtitle_lines(
        &self,
        bvid: &str,
        cid: i64,
        language: Option<&str>,
    ) -> Result<Vec<SubtitleLine>, ProviderError> {
        let data = self.player_metadata(bvid, cid).await?;
        match preferred_subtitle_entry(&data, language) {
            Some(entry) => self.subtitle_entry_lines(entry).await,
            None => Ok(vec![]),
        }
    }
    async fn subtitle_entry_lines(
        &self,
        entry: &Value,
    ) -> Result<Vec<SubtitleLine>, ProviderError> {
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
            if bytes.len() > 16 * 1024 * 1024 {
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
        Ok(parse_subtitle_lines(&value))
    }
    pub async fn media_options(&self, bvid: &str, cid: i64) -> Result<MediaOptions, ProviderError> {
        let dash = self.play_dash(bvid, cid, true).await?;
        let audio = audio_options(&dash);
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
    fn uses_the_first_available_episode_cover_when_the_collection_has_none() {
        let archives = json!([
            {"pic":"//i0.hdslb.com/viedeo_material_default.jpg"},
            {"pic":"//i0.hdslb.com/first.jpg"},
            {"pic":"//i0.hdslb.com/second.jpg"}
        ]);
        assert_eq!(
            first_archive_cover(&archives),
            Some("//i0.hdslb.com/first.jpg")
        );
        let tracks = archives
            .as_array()
            .unwrap()
            .iter()
            .map(|archive| season_member(archive, None))
            .collect::<Vec<_>>();
        let summary = SeasonSummary {
            id: 1,
            uploader_id: 2,
            title: "合集".into(),
            cover_url: String::new(),
            uploader_name: String::new(),
        };
        assert_eq!(
            season_cover(summary.clone(), &tracks).cover_url,
            "https://i0.hdslb.com/first.jpg"
        );
        let explicit = SeasonSummary {
            cover_url: "https://i0.hdslb.com/custom.jpg".into(),
            ..summary
        };
        assert_eq!(
            season_cover(explicit, &tracks).cover_url,
            "https://i0.hdslb.com/custom.jpg"
        );
    }

    #[test]
    fn sections_preserve_uploader_order_in_both_complete_and_paged_catalogs() {
        let raw = json!({"ep_count":3,"sections":[
            {"id":90,"title":"西汉","episodes":[
                {"bvid":"BVB","aid":2,"cid":22,"title":"汉匈之战","pages":[{"cid":22,"page":1,"part":"汉匈之战","duration":20}]},
                {"bvid":"BVA","aid":1,"cid":11,"title":"从何时起","pages":[{"cid":11,"page":1,"part":"从何时起","duration":10}]}]},
            {"id":10,"title":"汉末三国","episodes":[
                {"bvid":"BVC","aid":3,"cid":33,"title":"三国","pages":[{"cid":33,"page":1,"part":"三国","duration":30}]}]}
        ]});
        let summary = SeasonSummary {
            id: 1,
            uploader_id: 2,
            title: "中国通史".into(),
            cover_url: String::new(),
            uploader_name: String::new(),
        };
        let full = complete_season(&raw, &summary, "BVA").unwrap();
        assert_eq!(
            full.tracks
                .iter()
                .map(|t| t.bvid.as_str())
                .collect::<Vec<_>>(),
            ["BVB", "BVA", "BVC"]
        );
        assert_eq!(
            full.sections
                .iter()
                .map(|s| s.title.as_str())
                .collect::<Vec<_>>(),
            ["西汉", "汉末三国"]
        );
        assert_eq!(full.sections[0].bvids, ["BVB", "BVA"]);
        assert_eq!(full.sections[0].id, "90");
        // Partial inline detail must still classify and order paginated archives.
        let mut partial = raw.clone();
        partial["sections"][0]["episodes"][0]["pages"] = json!([]);
        assert!(complete_season(&partial, &summary, "BVA").is_none());
        let archives = vec![
            json!({"bvid":"BVC","title":"三国"}),
            json!({"bvid":"BVA","title":"从何时起"}),
            json!({"bvid":"BVB","title":"汉匈之战"}),
            json!({"bvid":"BVA"}),
            json!({}),
        ];
        let (tracks, unavailable) = paged_season_tracks(archives, Some(&partial));
        assert_eq!(unavailable, 1);
        assert_eq!(
            tracks.iter().map(|t| t.bvid.as_str()).collect::<Vec<_>>(),
            ["BVB", "BVA", "BVC"]
        );
        assert_eq!(
            serde_json::to_value(season_sections(&partial, &tracks)).unwrap(),
            serde_json::to_value(full.sections).unwrap()
        );
    }

    #[test]
    fn section_membership_excludes_unavailable_videos_and_keeps_unclassified_ones_in_all() {
        let raw = json!({"sections":[
            {"id":1,"title":"  ","episodes":[{"bvid":"A"},{"bvid":"A"},{"bvid":"removed"}]},
            {"id":1,"title":"空分类","episodes":[]},
            {"episodes":[{"bvid":"B"}]}
        ]});
        let (tracks, _) = paged_season_tracks(
            vec![
                json!({"bvid":"X"}),
                json!({"bvid":"B"}),
                json!({"bvid":"A"}),
            ],
            Some(&raw),
        );
        assert_eq!(
            tracks.iter().map(|t| t.bvid.as_str()).collect::<Vec<_>>(),
            ["A", "B", "X"]
        );
        let sections = season_sections(&raw, &tracks);
        assert_eq!(sections[0].title, "默认分类");
        assert_eq!(sections[0].bvids, ["A"]);
        assert!(sections[1].bvids.is_empty());
        assert_ne!(sections[0].id, sections[1].id);
        assert_eq!(sections[2].bvids, ["B"]);
        assert!(season_sections(&Value::Null, &tracks).is_empty());
        let (plain, _) = paged_season_tracks(vec![json!({"bvid":"B"}), json!({"bvid":"A"})], None);
        assert_eq!(
            plain.iter().map(|t| t.bvid.as_str()).collect::<Vec<_>>(),
            ["B", "A"]
        );
    }

    #[test]
    fn complete_snapshot_distinguishes_single_and_multi_part_videos() {
        let raw = json!({"ep_count":2,"sections":[{"episodes":[
            {"bvid":"BVsingle","aid":1,"cid":11,"arc":{"title":"Video title","videos":0,"pubdate":1700000000},"pages":[{"cid":11,"page":1,"part":"upload filename","duration":20}]},
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
        assert_eq!(season.tracks[0].published_at, Some(1700000000));
        assert_eq!(season.tracks[1].published_at, None);
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

#[cfg(test)]
mod chapter_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn player_chapters_keep_official_boundaries_and_order() {
        let data = json!({"view_points":[
            {"from":600.25,"to":720.501,"content":" 处理器 "},
            {"from":0,"to":530,"content":"引言"},
            {"from":600.25,"to":700,"content":"重复"},
            {"from":-1,"to":0,"content":"提前"},
            {"from":1,"to":1,"content":"空区间"},
            {"from":3,"to":4,"content":"  "},
            {"from":5,"to":1e80,"content":"不安全的数值"}
        ]});
        assert_eq!(
            serde_json::to_value(parse_video_chapters(&data).unwrap()).unwrap(),
            json!([
                {"startMs":0,"endMs":530000,"title":"引言"},
                {"startMs":600250,"endMs":720501,"title":"处理器"}
            ])
        );
    }

    #[test]
    fn no_official_chapters_is_distinct_from_a_malformed_list() {
        for empty in [
            json!({}),
            json!({"view_points":null}),
            json!({"view_points":[]}),
        ] {
            assert!(parse_video_chapters(&empty).unwrap().is_empty());
        }
        for malformed in [
            json!({"view_points":{}}),
            json!({"view_points":[{"content":"缺少时间"}]}),
        ] {
            assert!(matches!(
                parse_video_chapters(&malformed),
                Err(ProviderError::UnexpectedResponse)
            ));
        }
    }

    #[tokio::test]
    async fn chapters_and_subtitles_reuse_the_metadata_for_each_part_until_account_changes() {
        let provider = BilibiliProvider::new().unwrap();
        let bvid = "BV1qFuQz2EVx";
        let metadata = |data| {
            Arc::new(tokio::sync::OnceCell::new_with(Some((
                Instant::now(),
                Arc::new(data),
            ))))
        };
        {
            let mut player_metadata = provider.player_metadata.write().await;
            player_metadata.insert(
                (0, bvid.into(), 11),
                metadata(json!({
                    "view_points":[{"from":0,"to":30,"content":"第一段"}],
                    "subtitle":{"subtitles":[{"lan":"ai-zh","lan_doc":"中文"}]}
                })),
            );
            player_metadata.insert((0, bvid.into(), 12), metadata(json!({"view_points":[]})));
        }
        let (chapters, subtitles) = tokio::try_join!(
            provider.video_chapters(bvid, 11),
            provider.subtitles(bvid, 11)
        )
        .unwrap();
        assert_eq!(chapters[0].title, "第一段");
        assert_eq!(subtitles[0].language, "ai-zh");
        assert!(provider.video_chapters(bvid, 12).await.unwrap().is_empty());

        provider.set_session_cookie(None).await;
        assert!(provider.player_metadata.read().await.is_empty());
        assert!(matches!(
            provider.check_request_epoch(0),
            Err(ProviderError::AccountChanged)
        ));
    }
}

#[cfg(test)]
mod subtitle_regression_tests {
    use super::*;
    #[test]
    fn background_default_matches_foreground_selection_policy() {
        let choices = |entries| serde_json::json!({"subtitle": {"subtitles": entries}});
        let both = choices(serde_json::json!([
            {"lan":"zh-CN"}, {"lan":"ai-zh"}, {"lan":"en-US"}, {"lan":"ai-en-GB"}
        ]));
        let manual = choices(serde_json::json!([{"lan":""},{"lan":"en-US"}]));
        assert_eq!(
            preferred_subtitle_entry(&both, None).unwrap()["lan"],
            "ai-zh"
        );
        assert_eq!(
            preferred_subtitle_entry(&manual, None).unwrap()["lan"],
            "en-US"
        );
        assert_eq!(
            preferred_subtitle_entry(&both, Some("ai-en")).unwrap()["lan"],
            "ai-en-GB"
        );
        assert_eq!(
            preferred_subtitle_entry(&both, Some("en-AU")).unwrap()["lan"],
            "en-US"
        );
        assert_eq!(
            preferred_subtitle_entry(&both, Some("ai-ja")).unwrap()["lan"],
            "ai-zh"
        );
        assert!(
            preferred_subtitle_entry(&choices(serde_json::json!([{"lan":null}])), None).is_none()
        );
        assert_eq!(subtitle_language_key("ai-cmn-Hans"), "zh");
        assert_eq!(subtitle_language_key("AI-jpn"), "ja");
    }
    #[test]
    fn subtitles_keep_late_cues_in_multi_day_recordings() {
        let body: Vec<Value> = (0..40_001).rev().map(|i| serde_json::json!({
            "from": i as f64 * 15.5, "to": i as f64 * 15.5 + 10.0, "content": format!("第 {i} 句")
        })).collect();
        let lines = parse_subtitle_lines(&serde_json::json!({"body":body}));
        assert_eq!(lines.len(), 40_001);
        assert_eq!(lines[20_000].time_ms, 310_000_000);
        assert_eq!(lines.last().unwrap().text, "第 40000 句");
        assert_eq!(lines.last().unwrap().end_time_ms, 620_010_000);
    }
    #[test]
    fn subtitles_filter_invalid_cues_without_truncating_valid_neighbors() {
        let lines = parse_subtitle_lines(&serde_json::json!({"body":[
            {"from":2,"to":1,"content":"反向"}, {"from":-1,"to":1,"content":"负数"},
            {"from":1,"to":2,"content":"   "}, {"from":3,"to":4,"content":"正常"},
            {"from":1,"to":2,"content":"第一句"}
        ]}));
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].text, "第一句");
    }
}
