use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{
    AppHandle, Emitter, Manager, WebviewWindow,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
};

pub const LABEL: &str = "tray-player";
#[cfg(any(target_os = "macos", target_os = "windows"))]
const PANEL_SIZE: (f64, f64) = (280., 150.);

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn opens_player(
    button: tauri::tray::MouseButton,
    state: tauri::tray::MouseButtonState,
    right_click_opens_player: bool,
) -> bool {
    use tauri::tray::{MouseButton, MouseButtonState};
    state == MouseButtonState::Up
        && (button == MouseButton::Left
            || (right_click_opens_player && button == MouseButton::Right))
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub id: Option<String>,
    pub title: String,
    pub artist: String,
    pub cover_url: Option<String>,
    pub duration: f64,
    pub position: f64,
    pub playing: bool,
    pub advancing: bool,
    pub rate: f64,
    pub captured_at: u64,
    pub theme: String,
}

struct TrayPlayer {
    snapshot: Mutex<Snapshot>,
    track: MenuItem<tauri::Wry>,
    toggle: MenuItem<tauri::Wry>,
    previous: MenuItem<tauri::Wry>,
    next: MenuItem<tauri::Wry>,
}

impl TrayPlayer {
    fn update_menu(&self, snapshot: &Snapshot) -> tauri::Result<()> {
        let track = snapshot.id.is_some();
        let title = if track {
            format!("{} · {}", snapshot.title, snapshot.artist)
                .chars()
                .take(90)
                .collect::<String>()
                .replace(['\r', '\n'], " ")
                .replace('&', "&&")
        } else {
            "未在播放".into()
        };
        self.track.set_text(title)?;
        self.toggle
            .set_text(if snapshot.playing { "暂停" } else { "播放" })?;
        self.toggle.set_enabled(track)?;
        self.previous.set_enabled(track)?;
        self.next.set_enabled(track)
    }
}

pub fn initialize(app: &AppHandle) -> tauri::Result<()> {
    let track = MenuItem::with_id(app, "tray-track", "未在播放", false, None::<&str>)?;
    let show = MenuItem::with_id(app, "tray-show", "打开 BiliMusic", true, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "tray-toggle", "播放", false, None::<&str>)?;
    let previous = MenuItem::with_id(app, "tray-previous", "上一首", false, None::<&str>)?;
    let next = MenuItem::with_id(app, "tray-next", "下一首", false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray-quit", "退出", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[&track, &separator, &previous, &toggle, &next, &show, &quit],
    )?;
    app.manage(TrayPlayer {
        snapshot: Mutex::new(Snapshot::default()),
        track,
        toggle,
        previous,
        next,
    });
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    let panel_available = create_panel(app)
        .inspect_err(|error| {
            eprintln!("Unable to create tray player: {error}");
        })
        .is_ok();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let panel_available = false;
    let mut tray = TrayIconBuilder::with_id("bilimusic")
        .tooltip("BiliMusic")
        .show_menu_on_left_click(!panel_available)
        .on_menu_event(|app, event| {
            let action = match event.id.as_ref() {
                "tray-show" => Action::Show,
                "tray-toggle" => Action::Toggle,
                "tray-previous" => Action::Previous,
                "tray-next" => Action::Next,
                "tray-quit" => Action::Quit,
                _ => return,
            };
            let _ = perform(app, action);
        });
    // AppKit opens an attached menu on right mouse down. The macOS panel
    // already provides all actions, so leave the status item menu-free.
    if !panel_available || !cfg!(target_os = "macos") {
        tray = tray.menu(&menu);
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        use tauri::tray::TrayIconEvent;
        if panel_available {
            tray = tray.on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click {
                    button,
                    button_state,
                    position,
                    rect,
                    ..
                } = event
                {
                    if opens_player(button, button_state, cfg!(target_os = "macos")) {
                        if let Err(error) = toggle_panel(tray.app_handle(), position, rect) {
                            eprintln!("Unable to display tray player: {error}");
                        }
                    }
                }
            });
        }
    }
    #[cfg(target_os = "macos")]
    {
        tray = tray.icon(tauri::include_image!("icons/tray/32x32.png"));
    }
    #[cfg(not(target_os = "macos"))]
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

#[cfg(all(test, any(target_os = "macos", target_os = "windows")))]
mod tests {
    use super::opens_player;
    use tauri::tray::{MouseButton, MouseButtonState};

    #[test]
    fn tray_opens_once_on_release_and_keeps_windows_right_click_for_the_menu() {
        for button in [MouseButton::Left, MouseButton::Right] {
            assert!(!opens_player(button, MouseButtonState::Down, true));
            assert!(opens_player(button, MouseButtonState::Up, true));
        }
        assert!(!opens_player(
            MouseButton::Middle,
            MouseButtonState::Up,
            true
        ));
        assert!(opens_player(MouseButton::Left, MouseButtonState::Up, false));
        assert!(!opens_player(
            MouseButton::Right,
            MouseButtonState::Up,
            false
        ));
    }
}

pub fn update(app: &AppHandle, snapshot: &Snapshot) {
    let state = app.state::<TrayPlayer>();
    let menu_changed = {
        let Ok(mut current) = state.snapshot.lock() else {
            return;
        };
        if current.captured_at > snapshot.captured_at {
            return;
        }
        let changed = current.id != snapshot.id
            || current.title != snapshot.title
            || current.artist != snapshot.artist
            || current.playing != snapshot.playing;
        *current = snapshot.clone();
        changed
    };
    if menu_changed {
        let _ = state.update_menu(snapshot);
    }
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.emit_to(LABEL, "tray-player-state", snapshot);
    }
}

#[tauri::command]
pub fn tray_player_snapshot(window: WebviewWindow) -> Result<Snapshot, String> {
    if window.label() != LABEL {
        return Err("Invalid tray player window".into());
    }
    let state = window.state::<TrayPlayer>();
    state
        .snapshot
        .lock()
        .map(|value| value.clone())
        .map_err(|e| e.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", tag = "action")]
pub enum Action {
    Dismiss,
    Show,
    Quit,
    Previous,
    Toggle,
    Next,
}

#[tauri::command]
pub async fn tray_player_action(window: WebviewWindow, action: Action) -> Result<(), String> {
    if window.label() != LABEL {
        return Err("Invalid tray player window".into());
    }
    let app = window.app_handle().clone();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = perform(&handle, action);
    })
    .map_err(|e| e.to_string())
}

fn perform(app: &AppHandle, action: Action) -> tauri::Result<()> {
    match action {
        Action::Dismiss | Action::Show => {
            if let Some(window) = app.get_webview_window(LABEL) {
                window.hide()?;
            }
            if matches!(action, Action::Show) {
                crate::show_main_window(app);
            }
            Ok(())
        }
        Action::Quit => {
            app.exit(0);
            Ok(())
        }
        Action::Previous => crate::desktop_media::emit_action(app, "previous", 0.),
        Action::Toggle => crate::desktop_media::emit_action(app, "toggle", 0.),
        Action::Next => crate::desktop_media::emit_action(app, "next", 0.),
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn create_panel(app: &AppHandle) -> tauri::Result<()> {
    use tauri::{WebviewUrl, WebviewWindowBuilder, WindowEvent};
    let window =
        WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html?window=tray".into()))
            .title("BiliMusic")
            .decorations(false)
            .transparent(true)
            .resizable(false)
            .skip_taskbar(true)
            .always_on_top(true)
            .visible_on_all_workspaces(true)
            .shadow(true)
            .visible(false)
            .focused(false)
            .inner_size(PANEL_SIZE.0, PANEL_SIZE.1)
            .build()?;
    #[cfg(target_os = "macos")]
    crate::window_lifecycle::set_corner_radius(&window, Some(14.))?;
    let handle = window.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Focused(false) => {
            let _ = handle.hide();
        }
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let _ = handle.hide();
        }
        _ => {}
    });
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn toggle_panel(
    app: &AppHandle,
    cursor: tauri::PhysicalPosition<f64>,
    rect: tauri::Rect,
) -> tauri::Result<()> {
    use tauri::{LogicalSize, PhysicalPosition};
    let Some(panel) = app.get_webview_window(LABEL) else {
        return Ok(());
    };
    if panel.is_visible()? {
        return panel.hide();
    }
    let Some(monitor) = app
        .monitor_from_point(cursor.x, cursor.y)?
        .or(app.primary_monitor()?)
    else {
        return Ok(());
    };
    let scale = monitor.scale_factor();
    let icon = rect.position.to_physical::<f64>(scale);
    let icon_size = rect.size.to_physical::<f64>(scale);
    let work = monitor.work_area();
    let gap = 7. * scale;
    let left = f64::from(work.position.x);
    let top = f64::from(work.position.y);
    let right = left + f64::from(work.size.width);
    let bottom = top + f64::from(work.size.height);
    let width = PANEL_SIZE.0 * scale;
    let height = PANEL_SIZE.1 * scale;
    let above = icon.y - height - gap;
    let below = icon.y + icon_size.height + gap;
    let x = (icon.x + (icon_size.width - width) / 2.).clamp(left, (right - width).max(left));
    let y = if above >= top { above } else { below }.clamp(top, (bottom - height).max(top));
    panel.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32))?;
    panel.set_size(LogicalSize::new(PANEL_SIZE.0, PANEL_SIZE.1))?;
    panel.show()?;
    panel.set_focus()
}
