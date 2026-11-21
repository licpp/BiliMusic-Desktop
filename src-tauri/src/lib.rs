#[cfg(target_os = "android")]
mod android_playback;
#[cfg(desktop)]
mod desktop_media;
mod domain;
#[cfg(desktop)]
mod floating_lyrics;
mod global_shortcuts;
mod infrastructure;
mod interface;
#[cfg(target_os = "ios")]
mod ios_playback;
#[cfg(desktop)]
mod mini_player;
#[cfg(any(target_os = "ios", target_os = "android", target_env = "ohos", test))]
mod native_playback;
#[cfg(target_env = "ohos")]
mod ohos_playback;
mod sync;
#[cfg(desktop)]
mod tray_player;
mod window_lifecycle;
#[cfg(target_os = "windows")]
mod windows_taskbar;

use infrastructure::database::Database;
use infrastructure::media_proxy::MediaProxy;
use infrastructure::providers::bilibili::BilibiliProvider;
use infrastructure::providers::lrclib::LrclibProvider;
use infrastructure::providers::music_catalog::MusicCatalogProvider;
use infrastructure::repositories::auth::AuthRepository;
use tauri::Manager;

#[cfg(desktop)]
fn show_main_window(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.show();
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder =
        tauri::Builder::default().manage(infrastructure::update_install::UpdateState::default());
    #[cfg(all(desktop, not(target_env = "ohos")))]
    let builder = builder.plugin(
        tauri_plugin_updater::Builder::new()
            .pubkey(include_str!("../update-public-key.txt").trim())
            .build(),
    );
    #[cfg(desktop)]
    let builder = builder
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_denylist(&["floating-lyrics", "floating-lyrics-unlock", tray_player::LABEL])
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }));
    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_android_player::init());
    #[cfg(target_os = "ios")]
    let builder = builder.plugin(tauri_plugin_ios_player::init());
    #[cfg(target_env = "ohos")]
    let builder = builder.plugin(tauri_plugin_ohos_player::init());
    #[cfg(not(target_env = "ohos"))]
    let builder = builder.plugin(tauri_plugin_dialog::init()).plugin(
        tauri_plugin_opener::Builder::new()
            .open_js_links_on_click(false)
            .build(),
    );
    let builder = builder.plugin(tauri_plugin_store::Builder::default().build());

    builder
        .setup(|app| {
            let database = Database::open(app.handle())?;
            let media_proxy =
                tauri::async_runtime::block_on(MediaProxy::start_cached(app.handle().clone()))?;
            let bilibili = BilibiliProvider::new()?;
            let saved_cookie = database.0.lock().ok().and_then(|connection| {
                AuthRepository::get_cookie(&connection, "bilibili")
                    .ok()
                    .flatten()
            });
            tauri::async_runtime::block_on(bilibili.set_session_cookie(saved_cookie));
            app.manage(database);
            app.manage(sync::SyncState::default());
            app.manage(media_proxy);
            app.manage(bilibili);
            app.manage(LrclibProvider::new()?);
            app.manage(MusicCatalogProvider::new()?);
            global_shortcuts::start(app.handle().clone());
            #[cfg(desktop)]
            app.manage(mini_player::MiniPlayerState::default());
            #[cfg(desktop)]
            app.manage(floating_lyrics::FloatingLyrics::default());
            #[cfg(desktop)]
            desktop_media::initialize(app.handle());
            #[cfg(target_os = "ios")]
            ios_playback::initialize(app.handle().clone());
            #[cfg(target_os = "android")]
            {
                interface::media::observe_android_listening(app.handle().clone());
                android_playback::initialize(app.handle().clone());
            }
            #[cfg(target_env = "ohos")]
            {
                ohos_playback::initialize(app.handle().clone());
                interface::media::observe_ohos_listening(app.handle().clone());
            }
            #[cfg(desktop)]
            tray_player::initialize(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            interface::playback_cache::playback_cache_status,
            interface::playback_cache::offline_playable_tracks,
            interface::playback_cache::playback_cache_limit,
            interface::playback_cache::playback_cache_clear,
            #[cfg(desktop)]
            desktop_media::desktop_media_update,
            #[cfg(desktop)]
            tray_player::tray_player_snapshot,
            #[cfg(desktop)]
            tray_player::tray_player_action,
            #[cfg(desktop)]
            mini_player::desktop_mini_state,
            #[cfg(desktop)]
            floating_lyrics::floating_lyrics_snapshot,
            #[cfg(desktop)]
            floating_lyrics::floating_lyrics_update,
            #[cfg(desktop)]
            floating_lyrics::floating_lyrics_enable,
            #[cfg(desktop)]
            floating_lyrics::floating_lyrics_control,
            #[cfg(desktop)]
            floating_lyrics::floating_lyrics_configure,
            #[cfg(desktop)]
            floating_lyrics::floating_lyrics_unlock,
            #[cfg(desktop)]
            floating_lyrics::floating_lyrics_unlock_ready,
            #[cfg(desktop)]
            mini_player::desktop_mini_set,
            #[cfg(desktop)]
            mini_player::desktop_mini_panel,
            interface::playlist_import::external_playlist_read,
            #[cfg(all(desktop, not(target_env = "ohos")))]
            interface::local_playlist::local_playlist_pick,
            interface::playlist_import::playlist_import_scope,
            interface::playlist_import::playlist_import_archive,
            interface::playlist_import::playlist_import_commit,
            interface::imported_entries::playlist_import_entries,
            interface::imported_entries::playlist_import_contexts,
            interface::imported_entries::playlist_import_seed,
            interface::imported_entries::playlist_import_bind,
            interface::imported_entries::playlist_import_remove_missing,
            interface::batch_matching::batch_match_snapshot,
            interface::batch_matching::batch_match_commit,
            interface::batch_matching::lyric_match_version,
            global_shortcuts::global_shortcuts_apply,
            global_shortcuts::global_shortcuts_show,
            interface::media::bili_creator_catalog,
            interface::commands::collections_list,
            interface::commands::collections_change,
            interface::commands::collections_import_seasons,
            sync::sync_status,
            sync::repair::sync_archive_invalid_track_references,
            sync::devices::sync_devices,
            sync::devices::sync_retire_device,
            sync::background::sync_background,
            sync::background::sync_diagnostics,
            sync::sync_connect,
            sync::sync_pause,
            sync::sync_disconnect,
            sync::sync_now,
            sync::sync_conflict_options,
            sync::sync_import_guest,
            sync::sync_hydrate_sources,
            interface::visibility::content_visibility,
            interface::visibility::content_visibility_save,
            interface::list_preferences::list_preferences,
            interface::list_preferences::list_preferences_save,
            sync::sync_current_track,
            sync::sync_export,
            sync::sync_delete_cloud,
            interface::commands::app_health,
            interface::commands::app_check_update,
            infrastructure::update_install::app_download_update,
            infrastructure::update_install::app_install_update,
            interface::commands::app_open_download_page,
            interface::commands::library_summary,
            interface::commands::library_record_play,
            interface::commands::library_save_track,
            interface::commands::track_playback_url,
            interface::commands::track_playback_plan,
            interface::commands::playlist_rename,
            interface::commands::library_tracks,
            interface::commands::library_recent,
            interface::commands::playback_position,
            interface::commands::collection_progress,
            interface::commands::library_toggle_favorite,
            interface::commands::library_update_metadata,
            interface::commands::bili_search,
            interface::commands::bili_search_suggestions,
            interface::commands::search_history_list,
            interface::commands::search_history_clear,
            interface::commands::playlists_list,
            interface::commands::playlist_create,
            interface::commands::playlist_tracks,
            interface::commands::playlist_add_track,
            interface::commands::playlist_add_tracks,
            interface::commands::playlist_remove_track,
            interface::commands::playlist_remove_tracks,
            interface::commands::playlist_delete,
            interface::media::bili_season,
            interface::media::bili_subtitles,
            interface::media::bili_subtitle_lines,
            interface::media::bili_media_options,
            interface::media::media_preferences,
            interface::media::media_set_preferences,
            interface::media::listening_scope,
            interface::media::listening_record,
            interface::media::listening_statistics,
            sync::statistics::listening_sync,
            sync::statistics::listening_sync_configure,
            interface::commands::bili_video_parts,
            interface::commands::bili_video_pagelist,
            interface::commands::bili_playback_source,
            interface::commands::bili_video_source,
            interface::commands::bili_warm_playback,
            interface::commands::bili_danmaku,
            interface::commands::bili_qr_login_generate,
            interface::commands::bili_qr_login_poll,
            interface::commands::bili_account_profile,
            interface::commands::bili_favorite_folders,
            interface::commands::bili_subscribed_seasons,
            interface::commands::bili_favorite_videos,
            interface::linked_folders::bili_linked_folder,
            interface::linked_folders::bili_linked_create,
            interface::linked_folders::bili_linked_refresh,
            interface::linked_folders::bili_linked_change,
            interface::linked_folders::bili_linked_remove_selected,
            interface::linked_folders::bili_linked_unlink,
            interface::commands::bili_logout,
            interface::commands::bili_comments,
            interface::commands::bili_comment_emotes,
            interface::commands::bili_comment_replies,
            interface::commands::bili_comment_like,
            interface::commands::bili_comment_reply,
            interface::commands::lyrics_search,
            interface::commands::metadata_catalog_search,
            interface::commands::account_session,
            interface::commands::lyrics_get,
            interface::commands::lyrics_complete_selected,
            interface::commands::lyrics_restore_selected,
            interface::commands::lyrics_save,
            interface::commands::lyrics_save_with_metadata,
            interface::commands::lyrics_set_bias,
            interface::commands::mobile_download_directory,
            #[cfg(target_os = "android")]
            interface::commands::android_download_destination,
            #[cfg(any(target_os = "android", target_os = "ios"))]
            interface::commands::mobile_export_download,
            window_lifecycle::window_close_to_tray,
            interface::commands::downloads_list,
            interface::commands::download_remove,
            interface::commands::download_track,
        ])
        .on_window_event(|window, event| {
            #[cfg(desktop)]
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    // Keep the main WebView alive when hiding; otherwise exit the
                    // whole application, including lyrics and the tray icon.
                    api.prevent_close();
                    let window = window.clone();
                    tauri::async_runtime::spawn(async move {
                        window_lifecycle::close_main(&window);
                    });
                }
            }
            #[cfg(mobile)]
            let _ = (window, event);
        })
        .build(tauri::generate_context!())
        .expect("failed to build BiliMusic")
        .run(|app, event| {
            #[cfg(desktop)]
            if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
                floating_lyrics::remember_placement(app);
            }
            #[cfg(target_os = "macos")]
            if matches!(event, tauri::RunEvent::Reopen { .. }) {
                show_main_window(app);
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}
