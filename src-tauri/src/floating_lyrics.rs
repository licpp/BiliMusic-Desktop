//! Lyrics remain in a mouse-transparent window while locked. A separate, tightly
//! bounded window owns the unlock button, so its clicks can never leak down.
use serde_json::Value;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const LYRICS: &str = "floating-lyrics";
const UNLOCK: &str = "floating-lyrics-unlock";
const UNLOCK_WIDTH: f64 = 64.0;
const UNLOCK_HEIGHT: f64 = 28.0;

#[derive(Default)]
pub struct FloatingLyrics {
    frame: Mutex<Value>,
    locked: AtomicBool,
    ready: AtomicBool,
    watcher: AtomicU64,
}

#[derive(Debug, PartialEq)]
struct UnlockPlacement {
    x: f64,
    y: f64,
    hovered: bool,
}
// Inputs share screen units: macOS uses global logical points; other desktop
// runtimes use physical pixels. Keep negative monitor coordinates intact.
fn unlock_placement(
    origin: (f64, f64),
    size: (f64, f64),
    cursor: (f64, f64),
    scale: f64,
) -> Option<UnlockPlacement> {
    if ![
        origin.0, origin.1, size.0, size.1, cursor.0, cursor.1, scale,
    ]
    .iter()
    .all(|n| n.is_finite())
        || scale <= 0.0
        || size.0 < (UNLOCK_WIDTH + 14.0) * scale
        || size.1 < (UNLOCK_HEIGHT + 5.0) * scale
    {
        return None;
    }
    Some(UnlockPlacement {
        x: origin.0 + size.0 - (UNLOCK_WIDTH + 14.0) * scale,
        y: origin.1 + 5.0 * scale,
        hovered: cursor.0 >= origin.0
            && cursor.0 < origin.0 + size.0
            && cursor.1 >= origin.1
            && cursor.1 < origin.1 + size.1,
    })
}

#[cfg(any(target_os = "macos", test))]
fn mac_unlock_placement(
    origin: (f64, f64),
    size: (f64, f64),
    cursor: (f64, f64),
    window_scale: f64,
    cursor_scale: f64,
) -> Option<UnlockPlacement> {
    if !window_scale.is_finite()
        || window_scale <= 0.0
        || !cursor_scale.is_finite()
        || cursor_scale <= 0.0
    {
        return None;
    }
    unlock_placement(
        (origin.0 / window_scale, origin.1 / window_scale),
        (size.0 / window_scale, size.1 / window_scale),
        (cursor.0 / cursor_scale, cursor.1 / cursor_scale),
        1.0,
    )
}

fn sync_unlock(
    floating: &WebviewWindow,
    button: &WebviewWindow,
    previous: &mut Option<(f64, f64, f64)>,
) -> tauri::Result<()> {
    let origin = floating.inner_position()?;
    let size = floating.inner_size()?;
    let cursor = floating.cursor_position()?;
    let scale = floating.scale_factor()?;
    #[cfg(target_os = "macos")]
    let layout = {
        // Tao's global cursor uses the primary display scale, whereas a window's
        // origin uses its own display scale. Normalize before mixed-DPI hit tests.
        let cursor_scale = floating
            .primary_monitor()?
            .map(|m| m.scale_factor())
            .unwrap_or(scale);
        mac_unlock_placement(
            (origin.x as f64, origin.y as f64),
            (size.width as f64, size.height as f64),
            (cursor.x, cursor.y),
            scale,
            cursor_scale,
        )
    };
    #[cfg(not(target_os = "macos"))]
    let layout = unlock_placement(
        (origin.x as f64, origin.y as f64),
        (size.width as f64, size.height as f64),
        (cursor.x, cursor.y),
        scale,
    );
    let Some(layout) = layout else {
        if button.is_visible()? {
            button.hide()?;
        }
        return Ok(());
    };
    if !layout.hovered || !floating.is_visible()? || floating.is_minimized()? {
        if button.is_visible()? {
            button.hide()?;
        }
        return Ok(());
    }
    let placement = (layout.x, layout.y, scale);
    if previous.as_ref() != Some(&placement) {
        #[cfg(target_os = "macos")]
        button.set_position(tauri::LogicalPosition::new(layout.x, layout.y))?;
        #[cfg(not(target_os = "macos"))]
        {
            button.set_position(tauri::PhysicalPosition::new(
                layout.x.round() as i32,
                layout.y.round() as i32,
            ))?;
            button.set_size(tauri::PhysicalSize::new(
                (UNLOCK_WIDTH * scale).round() as u32,
                (UNLOCK_HEIGHT * scale).round() as u32,
            ))?;
        }
        *previous = Some(placement);
    }
    if !button.is_visible()? {
        button.show()?
    }
    Ok(())
}

fn watch_unlock(app: tauri::AppHandle, generation: u64) {
    tauri::async_runtime::spawn(async move {
        let queued = Arc::new(AtomicBool::new(false));
        let placement = Arc::new(Mutex::new(None));
        let mut timer = tokio::time::interval(std::time::Duration::from_millis(80));
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            timer.tick().await;
            let state = app.state::<FloatingLyrics>();
            if state.watcher.load(Ordering::Acquire) != generation {
                break;
            }
            if !state.locked.load(Ordering::Acquire) || !state.ready.load(Ordering::Acquire) {
                continue;
            }
            // Batch all AppKit reads/writes on the UI thread, without blocking a
            // runtime worker on a sequence of cross-thread getters. At most one
            // batch may wait in the event queue while the app is busy.
            if queued.swap(true, Ordering::AcqRel) {
                continue;
            }
            let handle = app.clone();
            let pending = queued.clone();
            let previous = placement.clone();
            if app
                .run_on_main_thread(move || {
                    let state = handle.state::<FloatingLyrics>();
                    if state.watcher.load(Ordering::Acquire) == generation
                        && state.locked.load(Ordering::Acquire)
                        && state.ready.load(Ordering::Acquire)
                    {
                        if let (Some(floating), Some(button)) = (
                            handle.get_webview_window(LYRICS),
                            handle.get_webview_window(UNLOCK),
                        ) {
                            if sync_unlock(&floating, &button, &mut previous.lock().unwrap())
                                .is_err()
                            {
                                let _ = button.hide();
                            }
                        }
                    }
                    pending.store(false, Ordering::Release);
                })
                .is_err()
            {
                queued.store(false, Ordering::Release);
                break;
            }
        }
    });
}

#[tauri::command]
pub fn floating_lyrics_snapshot(state: tauri::State<'_, FloatingLyrics>) -> Value {
    state.frame.lock().unwrap().clone()
}

#[tauri::command]
pub fn floating_lyrics_update(
    window: WebviewWindow,
    state: tauri::State<'_, FloatingLyrics>,
    frame: Value,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("此窗口不能修改播放状态".into());
    }
    if frame.to_string().len() > 1_000_000 {
        return Err("歌词内容过长".into());
    }
    *state.frame.lock().unwrap() = frame.clone();
    if let Some(button) = window.app_handle().get_webview_window(UNLOCK) {
        let _ = button.emit(
            "floating-lyrics-theme",
            frame.get("theme").cloned().unwrap_or(Value::Null),
        );
    }
    window
        .app_handle()
        .emit_to(LYRICS, "floating-lyrics-frame", frame)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn floating_lyrics_enable(window: WebviewWindow, enabled: bool) -> Result<(), String> {
    let app = window.app_handle();
    let state = app.state::<FloatingLyrics>();
    if !enabled {
        state.watcher.fetch_add(1, Ordering::AcqRel);
        // Reuse macOS WebKit views between uses to avoid tearing down a
        // scrolling tree while display-link callbacks may still be pending.
        #[cfg(target_os = "macos")]
        {
            if let Some(button) = app.get_webview_window(UNLOCK) {
                button.hide().map_err(|e| e.to_string())?;
            }
            if let Some(floating) = app.get_webview_window(LYRICS) {
                floating.hide().map_err(|e| e.to_string())?;
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            state.ready.store(false, Ordering::Release);
            *state.frame.lock().unwrap() = Value::Null;
            if let Some(button) = app.get_webview_window(UNLOCK) {
                let _ = button.close();
            }
            if let Some(floating) = app.get_webview_window(LYRICS) {
                floating.close().map_err(|e| e.to_string())?;
            }
        }
        let _ = app.emit_to("main", "floating-lyrics-closed", ());
        return Ok(());
    }
    if window.label() != "main" {
        return Err("请从主窗口开启悬浮歌词".into());
    }
    if let Some(floating) = app.get_webview_window(LYRICS) {
        floating.show().map_err(|e| e.to_string())?;
        let generation = state.watcher.fetch_add(1, Ordering::AcqRel) + 1;
        watch_unlock(app.clone(), generation);
        return Ok(());
    }
    state.ready.store(false, Ordering::Release);
    let floating = WebviewWindowBuilder::new(
        app,
        LYRICS,
        WebviewUrl::App("index.html?window=lyrics".into()),
    )
    .title("BiliMusic 悬浮歌词")
    .inner_size(720.0, 176.0)
    .min_inner_size(320.0, 176.0)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(true)
    .focused(false)
    .build()
    .map_err(|e| e.to_string())?;
    let button = WebviewWindowBuilder::new(
        app,
        UNLOCK,
        WebviewUrl::App("index.html?window=lyrics-unlock".into()),
    )
    .title("解锁悬浮歌词")
    .inner_size(UNLOCK_WIDTH, UNLOCK_HEIGHT)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .focused(false)
    .focusable(false)
    .accept_first_mouse(true)
    .visible(false);
    // AppKit child windows inherit their parent's ordering/hiding behavior.
    // Keep the button independent so it can show above a mouse-ignoring window.
    #[cfg(not(target_os = "macos"))]
    let button = button.parent(&floating).map_err(|e| e.to_string())?;
    let button = button.build();
    if let Err(error) = button {
        let _ = floating.close();
        return Err(error.to_string());
    }
    let locked = state.locked.load(Ordering::Acquire);
    if let Err(error) = floating
        .set_resizable(!locked)
        .and_then(|_| floating.set_ignore_cursor_events(locked))
    {
        if let Some(button) = app.get_webview_window(UNLOCK) {
            let _ = button.close();
        }
        let _ = floating.close();
        return Err(error.to_string());
    }
    let generation = state.watcher.fetch_add(1, Ordering::AcqRel) + 1;
    watch_unlock(app.clone(), generation);
    let handle = app.clone();
    floating.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            let state = handle.state::<FloatingLyrics>();
            let destroyed_generation = state.watcher.fetch_add(1, Ordering::AcqRel) + 1;
            {
                state.ready.store(false, Ordering::Release);
                let app = handle.clone();
                // Window event listeners are called while runtime listener
                // locks are held. Close the companion outside that callback.
                tauri::async_runtime::spawn(async move {
                    if app
                        .state::<FloatingLyrics>()
                        .watcher
                        .load(Ordering::Acquire)
                        != destroyed_generation
                    {
                        return;
                    }
                    if let Some(button) = app.get_webview_window(UNLOCK) {
                        let _ = button.close();
                    }
                    let _ = app.emit_to("main", "floating-lyrics-closed", ());
                });
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub fn floating_lyrics_control(window: WebviewWindow, action: String) -> Result<(), String> {
    if !["toggle", "previous", "next"].contains(&action.as_str()) {
        return Err("不支持的播放操作".into());
    }
    window
        .app_handle()
        .emit_to("main", "floating-lyrics-control", action)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn floating_lyrics_configure(window: WebviewWindow, locked: bool) -> Result<(), String> {
    if window.label() != "main" {
        return Err("请从主窗口调整锁定状态".into());
    }
    let app = window.app_handle();
    if let Some(floating) = app.get_webview_window(LYRICS) {
        floating
            .set_ignore_cursor_events(locked)
            .map_err(|e| e.to_string())?;
        floating.set_resizable(!locked).map_err(|e| e.to_string())?;
    }
    app.state::<FloatingLyrics>()
        .locked
        .store(locked, Ordering::Release);
    if !locked {
        if let Some(button) = app.get_webview_window(UNLOCK) {
            button.hide().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn floating_lyrics_unlock_ready(window: WebviewWindow) -> Result<(), String> {
    if window.label() != UNLOCK {
        return Err("无效的歌词按钮窗口".into());
    }
    window
        .app_handle()
        .state::<FloatingLyrics>()
        .ready
        .store(true, Ordering::Release);
    Ok(())
}

#[tauri::command]
pub fn floating_lyrics_unlock(window: WebviewWindow) -> Result<(), String> {
    if window.label() != UNLOCK {
        return Err("请使用悬浮歌词解锁按钮".into());
    }
    let app = window.app_handle();
    app.emit_to("main", "floating-lyrics-unlock", ())
        .map_err(|e| e.to_string())?;
    if let Some(floating) = app.get_webview_window(LYRICS) {
        floating
            .set_ignore_cursor_events(false)
            .map_err(|e| e.to_string())?;
        floating.set_resizable(true).map_err(|e| e.to_string())?;
    }
    app.state::<FloatingLyrics>()
        .locked
        .store(false, Ordering::Release);
    window.hide().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unlock_bounds_remain_small_on_scaled_and_negative_displays() {
        let point =
            unlock_placement((-1920.0, 100.0), (720.0, 176.0), (-1300.0, 120.0), 1.0).unwrap();
        assert_eq!((point.x, point.y), (-1278.0, 105.0));
        assert!(point.hovered);
        let retina =
            unlock_placement((200.0, 300.0), (1440.0, 352.0), (1000.0, 400.0), 2.0).unwrap();
        assert_eq!((retina.x, retina.y), (1484.0, 310.0));
        assert!(retina.hovered);
    }
    #[test]
    fn mac_hit_test_normalizes_primary_and_window_dpi_independently() {
        let external =
            mac_unlock_placement((-1500.0, 100.0), (720.0, 176.0), (-2600.0, 240.0), 1.0, 2.0)
                .unwrap();
        assert_eq!((external.x, external.y), (-858.0, 105.0));
        assert!(external.hovered);
        let retina =
            mac_unlock_placement((200.0, 300.0), (1440.0, 352.0), (500.0, 200.0), 2.0, 1.0)
                .unwrap();
        assert_eq!((retina.x, retina.y), (742.0, 155.0));
        assert!(retina.hovered);
        assert!(mac_unlock_placement((0.0, 0.0), (720.0, 176.0), (0.0, 0.0), 1.0, 0.0).is_none());
    }
    #[test]
    fn unlock_visibility_does_not_expand_the_lyric_windows_hit_region() {
        assert!(
            !unlock_placement((0.0, 0.0), (720.0, 176.0), (720.0, 20.0), 1.0)
                .unwrap()
                .hovered
        );
        assert!(
            !unlock_placement((0.0, 0.0), (720.0, 176.0), (10.0, 176.0), 1.0)
                .unwrap()
                .hovered
        );
        assert!(
            unlock_placement((0.0, 0.0), (720.0, 176.0), (0.0, 0.0), 1.0)
                .unwrap()
                .hovered
        );
        assert!(unlock_placement((0.0, 0.0), (20.0, 10.0), (1.0, 1.0), 1.0).is_none());
        assert!(unlock_placement((0.0, 0.0), (720.0, 176.0), (1.0, 1.0), f64::NAN).is_none());
    }
}
