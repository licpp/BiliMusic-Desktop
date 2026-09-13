mod application;
mod domain;
mod infrastructure;
mod interface;

use infrastructure::database::Database;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let database = Database::open(app.handle())?;
            app.manage(database);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            interface::commands::app_health,
            interface::commands::library_summary,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Resonance");
}
