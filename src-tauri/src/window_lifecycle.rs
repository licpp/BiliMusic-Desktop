use tauri_plugin_store::StoreExt;

#[derive(Debug, PartialEq)]
enum CloseAction {
    Hide,
    Exit,
}
fn close_action(mac: bool, to_tray: bool) -> CloseAction {
    if mac || to_tray {
        CloseAction::Hide
    } else {
        CloseAction::Exit
    }
}

#[tauri::command]
pub fn window_close_to_tray(app: tauri::AppHandle, enabled: Option<bool>) -> Result<bool, String> {
    let store = app.store("settings.json").map_err(|e| e.to_string())?;
    if let Some(enabled) = enabled {
        store.set("closeToTray", serde_json::json!(enabled));
        store.save().map_err(|e| e.to_string())?;
    }
    Ok(store
        .get("closeToTray")
        .and_then(|v| v.as_bool())
        .unwrap_or(false))
}

#[cfg(desktop)]
pub fn close_main(window: &tauri::Window) {
    use tauri::Manager;
    use tauri_plugin_window_state::{AppHandleExt, StateFlags};
    let app = window.app_handle();
    let _ = app.save_window_state(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED);
    let hide = close_action(
        cfg!(target_os = "macos"),
        window_close_to_tray(app.clone(), None).unwrap_or(false),
    );
    if hide == CloseAction::Hide {
        let _ = window.hide();
    } else {
        app.exit(0);
    }
}

#[cfg(target_os = "macos")]
pub fn set_corner_radius(window: &tauri::WebviewWindow, radius: Option<f64>) -> tauri::Result<()> {
    use objc2::{
        class, msg_send,
        runtime::{AnyObject, Bool},
    };
    window.set_background_color(radius.map(|_| tauri::window::Color(0, 0, 0, 0)))?;
    window.with_webview(move |webview| unsafe {
        let native = webview.ns_window() as *mut AnyObject;
        let rounded = radius.is_some();
        let color: *mut AnyObject = if rounded {
            msg_send![class!(NSColor), clearColor]
        } else {
            msg_send![class!(NSColor), windowBackgroundColor]
        };
        let _: () = msg_send![native, setOpaque: Bool::new(!rounded)];
        let _: () = msg_send![native, setBackgroundColor: color];
        let view: *mut AnyObject = msg_send![native, contentView];
        let _: () = msg_send![view, setWantsLayer: Bool::YES];
        let layer: *mut AnyObject = msg_send![view, layer];
        if !layer.is_null() {
            let _: () = msg_send![layer, setCornerRadius: radius.unwrap_or_default()];
            let _: () = msg_send![layer, setMasksToBounds: Bool::new(rounded)];
        }
        let _: () = msg_send![native, invalidateShadow];
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn windows_quits_by_default_and_mac_close_never_means_quit() {
        assert_eq!(close_action(false, false), CloseAction::Exit);
        assert_eq!(close_action(false, true), CloseAction::Hide);
        assert_eq!(close_action(true, false), CloseAction::Hide);
        assert_eq!(close_action(true, true), CloseAction::Hide);
    }
}
