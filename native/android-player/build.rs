fn main() {
    tauri_plugin::Builder::new(&["play", "control", "snapshot"])
        .android_path("android")
        .build();
}
