mod application;
mod domain;
mod infrastructure;
mod interface;

use infrastructure::database::Database;
use infrastructure::media_proxy::MediaProxy;
use infrastructure::providers::bilibili::BilibiliProvider;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build());

    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    builder
        .setup(|app| {
            let database = Database::open(app.handle())?;
            let media_proxy = tauri::async_runtime::block_on(MediaProxy::start())?;
            app.manage(database);
            app.manage(media_proxy);
            app.manage(BilibiliProvider::new()?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            interface::commands::app_health,
            interface::commands::library_summary,
            interface::commands::library_record_play,
            interface::commands::library_tracks,
            interface::commands::library_toggle_favorite,
            interface::commands::library_update_metadata,
            interface::commands::bili_search,
            interface::commands::bili_video_parts,
            interface::commands::bili_playback_source,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Resonance");
}
