fn main() {
    tauri_plugin::Builder::new(&[
        "play",
        "control",
        "snapshot",
        "register_listener",
        "remove_listener",
    ])
    .android_path("android")
    .build();
}
