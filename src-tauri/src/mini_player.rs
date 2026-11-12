//! Resize the existing player window: there is only one audio player and one queue.
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::Mutex};
use tauri::{LogicalSize, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

const MINI_HEIGHT: f64 = 72.0;
const NORMAL_MIN: (f64, f64) = (672.0, 460.0);

#[derive(Clone, Serialize, Deserialize)]
struct NormalWindow {
    width: u32,
    height: u32,
    x: i32,
    y: i32,
    maximized: bool,
    fullscreen: bool,
    decorated: bool,
    resizable: bool,
    always_on_top: bool,
}
#[derive(Default)]
pub struct MiniPlayerState(Mutex<WindowMode>);
#[derive(Default)]
struct WindowMode {
    normal: Option<NormalWindow>,
    initialized: bool,
    panel_position: Option<PhysicalPosition<i32>>,
}

fn shape(window: &WebviewWindow, mini: bool) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    {
        use objc2::{
            class, msg_send,
            runtime::{AnyObject, Bool},
        };
        window.set_background_color(if mini {
            Some(tauri::window::Color(0, 0, 0, 0))
        } else {
            None
        })?;
        window.with_webview(move |webview| unsafe {
            // Round the native window surface as well as the HTML content.
            let native = webview.ns_window() as *mut AnyObject;
            let color: *mut AnyObject = if mini {
                msg_send![class!(NSColor), clearColor]
            } else {
                msg_send![class!(NSColor), windowBackgroundColor]
            };
            let _: () = msg_send![native, setOpaque: Bool::new(!mini)];
            let _: () = msg_send![native, setBackgroundColor: color];
            let view: *mut AnyObject = msg_send![native, contentView];
            let _: () = msg_send![view, setWantsLayer: Bool::YES];
            let layer: *mut AnyObject = msg_send![view, layer];
            if !layer.is_null() {
                let _: () =
                    msg_send![layer, setCornerRadius: if mini { 16.0_f64 } else { 0.0_f64 }];
                let _: () = msg_send![layer, setMasksToBounds: Bool::new(mini)];
            }
            let _: () = msg_send![native, invalidateShadow];
            #[cfg(debug_assertions)]
            {
                let opaque: Bool = msg_send![native, isOpaque];
                let radius: f64 = msg_send![layer, cornerRadius];
                let color: *mut AnyObject = msg_send![native, backgroundColor];
                let alpha: f64 = msg_send![color, alphaComponent];
                eprintln!(
                    "mini_shape active={mini} opaque={} radius={radius} background_alpha={alpha}",
                    opaque.as_bool()
                );
            }
        })?;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (window, mini);
    Ok(())
}

fn backup_path(window: &WebviewWindow) -> Result<PathBuf, String> {
    window
        .app_handle()
        .path()
        .app_config_dir()
        .map(|p| p.join("mini-player-restore.json"))
        .map_err(|_| "无法保存窗口位置".into())
}
fn capture(window: &WebviewWindow) -> tauri::Result<NormalWindow> {
    let size = window.inner_size()?;
    let position = window.outer_position()?;
    Ok(NormalWindow {
        width: size.width,
        height: size.height,
        x: position.x,
        y: position.y,
        maximized: window.is_maximized()?,
        fullscreen: window.is_fullscreen()?,
        decorated: window.is_decorated()?,
        resizable: window.is_resizable()?,
        always_on_top: window.is_always_on_top()?,
    })
}
fn restore(window: &WebviewWindow, normal: &NormalWindow) -> tauri::Result<()> {
    shape(window, false)?;
    window.set_max_size(None::<LogicalSize<f64>>)?;
    window.set_min_size(Some(LogicalSize::new(NORMAL_MIN.0, NORMAL_MIN.1)))?;
    window.set_decorations(normal.decorated)?;
    window.set_resizable(normal.resizable)?;
    window.set_always_on_top(normal.always_on_top)?;
    window.set_size(PhysicalSize::new(normal.width, normal.height))?;
    let visible = window.available_monitors()?.iter().any(|m| {
        let p = m.position();
        let s = m.size();
        normal.x as i64 + normal.width as i64 > p.x as i64
            && normal.y as i64 + normal.height as i64 > p.y as i64
            && (normal.x as i64) < p.x as i64 + s.width as i64
            && (normal.y as i64) < p.y as i64 + s.height as i64
    });
    if visible {
        window.set_position(PhysicalPosition::new(normal.x, normal.y))?
    } else {
        window.center()?
    }
    if normal.maximized {
        window.maximize()?
    }
    if normal.fullscreen {
        window.set_fullscreen(true)?
    }
    Ok(())
}

#[tauri::command]
pub fn desktop_mini_state(
    window: WebviewWindow,
    state: tauri::State<'_, MiniPlayerState>,
) -> Result<bool, String> {
    let mut mode = state.0.lock().map_err(|_| "窗口正在切换，请稍后重试")?;
    if !mode.initialized {
        // The window-state plugin must never make a previous mini size the normal size.
        // Keep this snapshot across process exits/crashes, and recover after window setup.
        let path = backup_path(&window)?;
        if let Some(normal) = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<NormalWindow>(&bytes).ok())
        {
            restore(&window, &normal).map_err(|_| "无法恢复上次的窗口大小")?;
            let _ = std::fs::remove_file(path);
        }
        mode.initialized = true;
    }
    Ok(mode.normal.is_some())
}

#[tauri::command]
pub fn desktop_mini_set(
    window: WebviewWindow,
    state: tauri::State<'_, MiniPlayerState>,
    enabled: bool,
) -> Result<bool, String> {
    let mut mode = state.0.lock().map_err(|_| "窗口正在切换，请稍后重试")?;
    if enabled == mode.normal.is_some() {
        return Ok(enabled);
    }
    let path = backup_path(&window)?;
    if enabled {
        let normal = capture(&window).map_err(|_| "无法读取当前窗口状态")?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|_| "无法保存窗口状态")?
        }
        std::fs::write(
            &path,
            serde_json::to_vec(&normal).map_err(|_| "无法保存窗口状态")?,
        )
        .map_err(|_| "无法保存窗口状态")?;
        let change = (|| -> tauri::Result<()> {
            if normal.fullscreen {
                window.set_fullscreen(false)?
            }
            if normal.maximized {
                window.unmaximize()?
            }
            window.set_min_size(Some(LogicalSize::new(400.0, MINI_HEIGHT)))?;
            window.set_max_size(Some(LogicalSize::new(720.0, MINI_HEIGHT)))?;
            window.set_decorations(false)?;
            window.set_shadow(true)?;
            window.set_resizable(true)?;
            window.set_size(LogicalSize::new(480.0, MINI_HEIGHT))?;
            window.set_always_on_top(true)?;
            shape(&window, true)?;
            Ok(())
        })();
        if change.is_err() {
            if restore(&window, &normal).is_ok() {
                let _ = std::fs::remove_file(path);
            }
            return Err("无法打开迷你播放器，请重试".into());
        }
        mode.normal = Some(normal);
        mode.panel_position = None;
    } else if let Some(normal) = mode.normal.as_ref() {
        restore(&window, normal).map_err(|_| "无法恢复窗口，请重试")?;
        mode.normal = None;
        mode.panel_position = None;
        let _ = std::fs::remove_file(path);
    }
    mode.initialized = true;
    Ok(enabled)
}

#[tauri::command]
pub fn desktop_mini_panel(
    window: WebviewWindow,
    state: tauri::State<'_, MiniPlayerState>,
    expanded: bool,
) -> Result<(), String> {
    let mut mode = state.0.lock().map_err(|_| "窗口正在切换")?;
    if mode.normal.is_none() {
        return Ok(());
    }
    let change = (|| -> tauri::Result<()> {
        if expanded && mode.panel_position.is_none() {
            mode.panel_position = Some(window.outer_position()?);
        }
        let height = if expanded { 304.0 } else { MINI_HEIGHT };
        let size = window
            .inner_size()?
            .to_logical::<f64>(window.scale_factor()?);
        window.set_min_size(Some(LogicalSize::new(400.0, MINI_HEIGHT)))?;
        window.set_max_size(None::<LogicalSize<f64>>)?;
        window.set_size(LogicalSize::new(size.width, height))?;
        window.set_min_size(Some(LogicalSize::new(400.0, height)))?;
        window.set_max_size(Some(LogicalSize::new(720.0, height)))?;
        if expanded {
            if let Some(monitor) = window.current_monitor()? {
                let bottom = monitor.position().y + monitor.size().height as i32;
                let position = window.outer_position()?;
                let pixels = (height * window.scale_factor()?) as i32;
                if position.y + pixels > bottom {
                    window.set_position(PhysicalPosition::new(
                        position.x,
                        (bottom - pixels - 12).max(monitor.position().y),
                    ))?;
                }
            }
        } else if let Some(position) = mode.panel_position.take() {
            window.set_position(position)?;
        }
        Ok(())
    })();
    change.map_err(|_| "无法调整迷你播放列表".to_owned())
}
