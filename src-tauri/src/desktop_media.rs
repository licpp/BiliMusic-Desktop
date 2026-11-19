use serde::{Deserialize, Serialize};
use souvlaki::{
    MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition, PlatformConfig,
    SeekDirection,
};
use std::{sync::Mutex, time::Duration};
use tauri::{Emitter, Manager};

pub struct DesktopMedia(Mutex<Option<MediaControls>>);
#[derive(Serialize, Clone)]
struct RemoteAction {
    action: &'static str,
    seconds: f64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaSnapshot {
    #[serde(flatten)]
    track: crate::tray_player::Snapshot,
    album: String,
    metadata_changed: bool,
}

pub fn emit_action(
    app: &tauri::AppHandle,
    action: &'static str,
    seconds: f64,
) -> tauri::Result<()> {
    app.emit_to(
        "main",
        "desktop-media-command",
        RemoteAction { action, seconds },
    )
}

pub fn initialize(app: &tauri::AppHandle) {
    #[cfg(target_os = "windows")]
    let hwnd = app
        .get_webview_window("main")
        .and_then(|window| window.hwnd().ok())
        .map(|handle| handle.0 as *mut std::ffi::c_void);
    #[cfg(not(target_os = "windows"))]
    let hwnd = None;
    let controls = MediaControls::new(PlatformConfig {
        display_name: "BiliMusic",
        dbus_name: "BiliMusic",
        hwnd,
    })
    .ok()
    .and_then(|mut controls| {
        let handle = app.clone();
        controls
            .attach(move |event| {
                let (action, seconds) = match event {
                    MediaControlEvent::Play => ("play", 0.),
                    MediaControlEvent::Pause | MediaControlEvent::Stop => ("pause", 0.),
                    MediaControlEvent::Toggle => ("toggle", 0.),
                    MediaControlEvent::Next => ("next", 0.),
                    MediaControlEvent::Previous => ("previous", 0.),
                    MediaControlEvent::SetPosition(position) => ("seek", position.0.as_secs_f64()),
                    MediaControlEvent::Seek(direction) => (
                        "seekBy",
                        if direction == SeekDirection::Forward {
                            10.
                        } else {
                            -10.
                        },
                    ),
                    MediaControlEvent::SeekBy(direction, duration) => (
                        "seekBy",
                        duration.as_secs_f64()
                            * if direction == SeekDirection::Forward {
                                1.
                            } else {
                                -1.
                            },
                    ),
                    _ => return,
                };
                let _ = emit_action(&handle, action, seconds);
            })
            .ok()?;
        Some(controls)
    });
    app.manage(DesktopMedia(Mutex::new(controls)));
}
#[tauri::command]
pub fn desktop_media_update(app: tauri::AppHandle, snapshot: MediaSnapshot) -> Result<(), String> {
    let handle = app.clone();
    app.run_on_main_thread(move || {
        crate::tray_player::update(&handle, &snapshot.track);
        let state = handle.state::<DesktopMedia>();
        let Ok(mut guard) = state.0.lock() else {
            return;
        };
        let Some(controls) = guard.as_mut() else {
            return;
        };
        let track = snapshot.track;
        if snapshot.metadata_changed {
            let _ = controls.set_metadata(MediaMetadata {
                title: Some(&track.title),
                artist: Some(&track.artist),
                album: Some(&snapshot.album),
                cover_url: track.cover_url.as_deref(),
                duration: (track.duration.is_finite() && track.duration > 0.)
                    .then(|| Duration::from_secs_f64(track.duration)),
            });
        }
        let progress = Some(MediaPosition(Duration::from_secs_f64(
            if track.position.is_finite() {
                track.position.max(0.)
            } else {
                0.
            },
        )));
        let _ = controls.set_playback(if track.id.is_none() {
            MediaPlayback::Stopped
        } else if track.playing {
            MediaPlayback::Playing { progress }
        } else {
            MediaPlayback::Paused { progress }
        });
    })
    .map_err(|e| e.to_string())
}
