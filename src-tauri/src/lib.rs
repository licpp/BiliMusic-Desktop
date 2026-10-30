mod domain;
mod infrastructure;
mod interface;
mod sync;

use infrastructure::database::Database;
use infrastructure::media_proxy::MediaProxy;
use infrastructure::providers::bilibili::BilibiliProvider;
use infrastructure::providers::lrclib::LrclibProvider;
use infrastructure::providers::music_catalog::MusicCatalogProvider;
use infrastructure::repositories::auth::AuthRepository;
use tauri::Manager;
#[cfg(desktop)]
use tauri::{
    Emitter,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));
    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_android_player::init());
    let builder = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .plugin(tauri_plugin_store::Builder::default().build());

    builder
        .setup(|app| {
            let database = Database::open(app.handle())?;
            let media_proxy = tauri::async_runtime::block_on(MediaProxy::start())?;
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
            #[cfg(desktop)]
            {
                let show = MenuItem::with_id(app, "show", "显示 BiliMusic", true, None::<&str>)?;
                let play_pause =
                    MenuItem::with_id(app, "play_pause", "播放 / 暂停", true, None::<&str>)?;
                let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&show, &play_pause, &quit])?;
                let mut tray = TrayIconBuilder::new()
                    .tooltip("BiliMusic")
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "play_pause" => {
                            let _ = app.emit("tray-play-pause", ());
                        }
                        "quit" => app.exit(0),
                        _ => {}
                    });
                #[cfg(target_os = "macos")]
                {
                    tray = tray
                        .icon(tauri::include_image!("icons/tray/32x32.png"))
                        .icon_as_template(false);
                }
                #[cfg(not(target_os = "macos"))]
                if let Some(icon) = app.default_window_icon() {
                    tray = tray.icon(icon.clone());
                }
                tray.build(app)?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            interface::commands::collections_list,
            interface::commands::collections_change,
            sync::sync_status,
            sync::sync_connect,
            sync::sync_pause,
            sync::sync_disconnect,
            sync::sync_now,
            sync::sync_import_guest,
            sync::sync_hydrate_sources,
            sync::sync_current_track,
            sync::sync_export,
            sync::sync_delete_cloud,
            interface::commands::app_health,
            interface::commands::app_check_update,
            interface::commands::app_open_download_page,
            interface::commands::library_summary,
            interface::commands::library_record_play,
            interface::commands::library_save_track,
            interface::commands::track_playback_url,
            interface::commands::playlist_rename,
            interface::commands::library_tracks,
            interface::commands::library_recent,
            interface::commands::library_toggle_favorite,
            interface::commands::library_update_metadata,
            interface::commands::bili_search,
            interface::commands::search_history_list,
            interface::commands::search_history_clear,
            interface::commands::playlists_list,
            interface::commands::playlist_create,
            interface::commands::playlist_tracks,
            interface::commands::playlist_add_track,
            interface::commands::playlist_remove_track,
            interface::commands::playlist_delete,
            interface::commands::bili_video_parts,
            interface::commands::bili_playback_source,
            interface::commands::bili_video_source,
            interface::commands::bili_danmaku,
            interface::commands::bili_qr_login_generate,
            interface::commands::bili_qr_login_poll,
            interface::commands::bili_account_profile,
            interface::commands::bili_favorite_folders,
            interface::commands::bili_favorite_videos,
            interface::commands::bili_logout,
            interface::commands::bili_comments,
            interface::commands::bili_comment_replies,
            interface::commands::bili_comment_like,
            interface::commands::bili_comment_reply,
            interface::commands::lyrics_search,
            interface::commands::metadata_catalog_search,
            interface::commands::lyrics_get,
            interface::commands::lyrics_restore_selected,
            interface::commands::lyrics_save,
            interface::commands::lyrics_set_bias,
            interface::commands::mobile_download_directory,
            interface::commands::downloads_list,
            interface::commands::download_track,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run BiliMusic");
}
