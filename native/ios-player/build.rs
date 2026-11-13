fn main() {
    tauri_plugin::Builder::new(&[
        "lyrics",
        "play",
        "control",
        "snapshot",
        "queue",
        "register_listener",
        "remove_listener",
    ])
    .ios_path("ios")
    .build();
}
