use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("android-player")
        .setup(|_app, api| {
            #[cfg(target_os = "android")]
            api.register_android_plugin("app.bilimusic.player", "PlayerPlugin")?;
            Ok(())
        })
        .build()
}
