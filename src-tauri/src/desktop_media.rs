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
    id: Option<String>,
    title: String,
    artist: String,
    album: String,
    cover_url: Option<String>,
    duration: f64,
    position: f64,
    playing: bool,
    metadata_changed: bool,
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
                let _ = handle.emit("desktop-media-command", RemoteAction { action, seconds });
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
        let state = handle.state::<DesktopMedia>();
        let Ok(mut guard) = state.0.lock() else {
            return;
        };
        let Some(controls) = guard.as_mut() else {
            return;
        };
        if snapshot.metadata_changed {
            let _ = controls.set_metadata(MediaMetadata {
                title: Some(&snapshot.title),
                artist: Some(&snapshot.artist),
                album: Some(&snapshot.album),
                cover_url: snapshot.cover_url.as_deref(),
                duration: (snapshot.duration.is_finite() && snapshot.duration > 0.)
                    .then(|| Duration::from_secs_f64(snapshot.duration)),
            });
        }
        let progress = Some(MediaPosition(Duration::from_secs_f64(
            if snapshot.position.is_finite() {
                snapshot.position.max(0.)
            } else {
                0.
            },
        )));
        let _ = controls.set_playback(if snapshot.id.is_none() {
            MediaPlayback::Stopped
        } else if snapshot.playing {
            MediaPlayback::Playing { progress }
        } else {
            MediaPlayback::Paused { progress }
        });
    })
    .map_err(|e| e.to_string())
}
