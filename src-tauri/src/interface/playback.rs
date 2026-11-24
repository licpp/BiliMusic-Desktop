use super::error::CommandError;
use crate::infrastructure::database::Database;
use crate::infrastructure::media_proxy::MediaProxy;
use crate::infrastructure::providers::bilibili::BilibiliProvider;
use crate::infrastructure::repositories::library::LibraryRepository;
use crate::infrastructure::repositories::loudness::LoudnessRepository;
use serde::Serialize;
use tauri::State;

#[tauri::command]
pub fn collection_progress(
    database: State<'_, Database>,
    reference: String,
) -> Result<
    Option<crate::infrastructure::repositories::collections::CollectionProgress>,
    CommandError,
> {
    let connection = database.0.lock().map_err(CommandError::database)?;
    crate::infrastructure::repositories::collections::progress(&connection, &reference)
        .map_err(CommandError::database)
}

#[tauri::command]
pub fn playback_position(
    app: tauri::AppHandle,
    database: State<'_, Database>,
    track_id: String,
    seconds: Option<f64>,
    observed_at: Option<i64>,
    scope: Option<String>,
    collection_ref: Option<String>,
) -> Result<f64, CommandError> {
    let connection = database
        .0
        .lock()
        .map_err(|_| CommandError::database("数据库正忙"))?;
    if let (Some(seconds), Some(observed_at), Some(scope)) = (seconds, observed_at, scope) {
        if !super::media::playback_account_matches(&connection, &scope)
            .map_err(CommandError::database)?
        {
            return Ok(0.0);
        }
        LibraryRepository::save_playback_position(&connection, &track_id, seconds, observed_at)
            .map_err(CommandError::database)?;
        if let Some(reference) = collection_ref
            && crate::infrastructure::repositories::collections::save_progress(
                &connection,
                &reference,
                &track_id,
                seconds,
                observed_at,
            )
            .map_err(CommandError::database)?
        {
            use tauri::Emitter;
            let _ = app.emit("collection-progress-changed", reference);
        }
    }
    LibraryRepository::playback_position(&connection, &track_id).map_err(CommandError::database)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackPlan {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upgrade_url: Option<String>,
    pub loudness_gain_db: f64,
    pub source: crate::infrastructure::diagnostics::Source,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_quality: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual_quality: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codec: Option<String>,
}
impl PlaybackPlan {
    fn direct(
        url: String,
        loudness_gain_db: f64,
        source: crate::infrastructure::diagnostics::Source,
    ) -> Self {
        Self {
            url,
            upgrade_url: None,
            loudness_gain_db,
            source,
            requested_quality: None,
            actual_quality: None,
            codec: None,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PlaybackStartup {
    Selected,
    Progressive,
    Compatible,
}

#[tauri::command]
pub async fn track_playback_url(
    database: State<'_, Database>,
    provider: State<'_, BilibiliProvider>,
    media_proxy: State<'_, MediaProxy>,
    track_id: String,
    refresh: Option<bool>,
    prefer_online: Option<bool>,
) -> Result<String, CommandError> {
    playback_plan(
        database,
        provider,
        media_proxy,
        track_id,
        refresh,
        prefer_online,
        PlaybackStartup::Selected,
        false,
    )
    .await
    .map(|plan| plan.url)
}

#[tauri::command]
pub async fn track_playback_plan(
    database: State<'_, Database>,
    provider: State<'_, BilibiliProvider>,
    media_proxy: State<'_, MediaProxy>,
    track_id: String,
    refresh: Option<bool>,
    prefer_online: Option<bool>,
    offline_only: Option<bool>,
) -> Result<PlaybackPlan, CommandError> {
    let offline_only = offline_only.unwrap_or(false);
    let prefer_online = prefer_online.filter(|_| !offline_only);
    playback_plan(
        database,
        provider,
        media_proxy,
        track_id,
        refresh,
        prefer_online,
        if prefer_online == Some(true) {
            PlaybackStartup::Selected
        } else {
            PlaybackStartup::Progressive
        },
        offline_only,
    )
    .await
}

pub(crate) async fn compatible_playback_plan(
    database: State<'_, Database>,
    provider: State<'_, BilibiliProvider>,
    media_proxy: State<'_, MediaProxy>,
    track_id: String,
) -> Result<PlaybackPlan, CommandError> {
    playback_plan(
        database,
        provider,
        media_proxy,
        track_id,
        Some(true),
        Some(true),
        PlaybackStartup::Compatible,
        false,
    )
    .await
}

async fn playback_plan(
    database: State<'_, Database>,
    provider: State<'_, BilibiliProvider>,
    media_proxy: State<'_, MediaProxy>,
    track_id: String,
    refresh: Option<bool>,
    prefer_online: Option<bool>,
    startup: PlaybackStartup,
    offline_only: bool,
) -> Result<PlaybackPlan, CommandError> {
    use crate::infrastructure::diagnostics::Source;
    media_proxy.ensure_running().await.map_err(|_| {
        CommandError::new(
            "proxy_unavailable",
            "本机音频服务恢复失败，请稍后重试",
            true,
        )
    })?;
    let (track, paths, mut loudness_gain_db, account_session) = {
        let connection = database
            .0
            .lock()
            .map_err(|_| CommandError::database("数据库正忙"))?;
        let track = LibraryRepository::get(&connection, &track_id)
            .map_err(CommandError::database)?
            .ok_or_else(|| CommandError::new("track_missing", "歌曲不存在", false))?;
        let mut statement = connection.prepare("SELECT target_path FROM downloads WHERE track_id=?1 AND status='completed' ORDER BY updated_at DESC").map_err(CommandError::database)?;
        let paths = statement
            .query_map([&track_id], |row| row.get::<_, String>(0))
            .map_err(CommandError::database)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(CommandError::database)?;
        let gain = LoudnessRepository::get(&connection, &track.bvid, track.cid)
            .ok()
            .flatten()
            .map(|d| d.gain_db())
            .unwrap_or(0.0);
        let account_session = crate::infrastructure::database::account_session(&connection)
            .map_err(CommandError::database)?;
        (track, paths, gain, account_session)
    };
    for path in paths
        .into_iter()
        .filter(|_| !prefer_online.unwrap_or(false))
    {
        let path = std::path::PathBuf::from(path);
        if tokio::fs::metadata(&path)
            .await
            .is_ok_and(|metadata| metadata.is_file() && metadata.len() > 0)
        {
            return Ok(PlaybackPlan::direct(
                media_proxy.register_local(path).await,
                loudness_gain_db,
                Source::LocalDownload,
            ));
        }
    }
    let quality = {
        let c = database
            .0
            .lock()
            .map_err(|_| CommandError::database("数据库正忙"))?;
        crate::interface::media::preferences(&c).map_err(CommandError::database)?
    };
    if !prefer_online.unwrap_or(false) {
        if let Some(url) = media_proxy
            .complete_cached_audio(&track_id, quality.audio_id)
            .await
        {
            return Ok(PlaybackPlan::direct(
                media_proxy
                    .platform_cached_url(url, track.duration_seconds)
                    .await,
                loudness_gain_db,
                Source::Cache,
            ));
        }
    }
    if offline_only {
        return Err(CommandError::new(
            "offline_unavailable",
            "此歌曲尚未保存在本机",
            false,
        ));
    }
    if refresh.unwrap_or(false) {
        media_proxy
            .refresh_connections()
            .await
            .map_err(CommandError::provider)?;
        provider.invalidate_playback(&track.bvid, track.cid).await;
    }
    let sources = match startup {
        PlaybackStartup::Progressive => {
            provider
                .playback_startup_sources(&track.bvid, track.cid, quality.audio_id)
                .await
        }
        PlaybackStartup::Selected => provider
            .playback_source_with_quality(&track.bvid, track.cid, quality.audio_id)
            .await
            .map(|source| (source, None)),
        PlaybackStartup::Compatible => provider
            .compatible_audio_source(&track.bvid, track.cid)
            .await
            .map(|source| (source, None)),
    };
    let (source, initial) = match sources {
        Ok(source) => source,
        Err(error) => {
            if prefer_online.unwrap_or(false) {
                return Err(CommandError::audio_source(error));
            }
            if let Some(url) = media_proxy.cached_audio(&track_id, quality.audio_id).await {
                return Ok(PlaybackPlan::direct(
                    media_proxy
                        .platform_cached_url(url, track.duration_seconds)
                        .await,
                    loudness_gain_db,
                    Source::Cache,
                ));
            }
            return Err(CommandError::audio_source(error));
        }
    };
    if let Some(descriptor) = provider.cached_loudness(&track.bvid, track.cid).await {
        loudness_gain_db = descriptor.gain_db();
        if let Ok(connection) = database.0.lock() {
            let _ =
                LoudnessRepository::save_for_session(&connection, &account_session, &descriptor);
        }
    }
    let target_quality = source.quality_id;
    let target_codecs = source.codecs.clone();
    if startup == PlaybackStartup::Compatible {
        // The decoder might have rejected the cached bytes of this same rendition.
        let url = media_proxy
            .register_stream(source.audio_url, source.backup_urls, source.mime_type)
            .await;
        return Ok(PlaybackPlan {
            requested_quality: Some(quality.audio_id),
            actual_quality: Some(target_quality),
            codec: Some(target_codecs),
            ..PlaybackPlan::direct(url, loudness_gain_db, Source::Online)
        });
    }
    let target_bandwidth = source.bandwidth;
    let target = media_proxy
        .register_audio(&track_id, &track.bvid, track.cid, quality.audio_id, source)
        .await;
    if let Some(initial) = initial {
        let target = media_proxy
            .platform_upgrade_url(target, track.duration_seconds, &target_codecs)
            .await;
        let target = media_proxy.guard_upgrade(&target, target_bandwidth).await;
        let initial_quality = initial.quality_id;
        let initial_codecs = initial.codecs.clone();
        let url = media_proxy
            .register_audio(
                &track_id,
                &track.bvid,
                track.cid,
                initial.quality_id,
                initial,
            )
            .await;
        let url = media_proxy
            .platform_audio_url(url, track.duration_seconds, &initial_codecs)
            .await;
        Ok(PlaybackPlan {
            upgrade_url: Some(target),
            requested_quality: Some(quality.audio_id),
            actual_quality: Some(initial_quality),
            codec: Some(initial_codecs),
            ..PlaybackPlan::direct(url, loudness_gain_db, Source::Online)
        })
    } else {
        let target = media_proxy
            .platform_audio_url(target, track.duration_seconds, &target_codecs)
            .await;
        Ok(PlaybackPlan {
            requested_quality: Some(quality.audio_id),
            actual_quality: Some(target_quality),
            codec: Some(target_codecs),
            ..PlaybackPlan::direct(target, loudness_gain_db, Source::Online)
        })
    }
}
