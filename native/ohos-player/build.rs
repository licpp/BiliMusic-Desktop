fn main() {
    tauri_plugin::Builder::new(&["lyrics", "play", "control", "snapshot", "observe"]).build();
}
