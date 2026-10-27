// Windows release builds are GUI applications; keep the console for development.
#![cfg_attr(
    all(target_os = "windows", not(debug_assertions)),
    windows_subsystem = "windows"
)]

fn main() {
    bilimusic_lib::run();
}
