fn main() {
    tauri_plugin::Builder::new(&["play", "control", "snapshot", "observe"]).build();
}
