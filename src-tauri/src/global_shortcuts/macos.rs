use super::{
    GlobalBinding,
    registry::{self, ActiveBinding, BindingError, Platform, Registrar, Registration},
};
use std::{
    collections::HashMap,
    ffi::c_void,
    sync::{Condvar, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};
#[path = "carbon.rs"]
mod carbon;

const SHOW_ID: u32 = u32::MAX;
static APP: OnceLock<AppHandle> = OnceLock::new();
static STATE: OnceLock<Mutex<State>> = OnceLock::new();
static WAKE: Condvar = Condvar::new();
#[derive(Default)]
struct MacRegistrar {
    handles: HashMap<i32, usize>,
    native_ids: HashMap<u32, i32>,
    serial: u32,
}
impl Registrar for MacRegistrar {
    fn unregister(&mut self, id: i32) {
        self.native_ids.retain(|_, value| *value != id);
        if let Some(handle) = self.handles.remove(&id) {
            carbon::unregister(handle);
        }
    }
    fn register(&mut self, id: i32, modifiers: u32, key: u32) -> Result<(), u32> {
        // A queued event from a previous registration must never execute a newly
        // assigned action that happens to reuse the same logical slot.
        self.serial = self
            .serial
            .checked_add(1)
            .filter(|id| *id != SHOW_ID)
            .ok_or(1u32)?;
        let native_id = self.serial;
        let handle = carbon::register(key, modifiers, native_id).map_err(|code| code as u32)?;
        self.handles.insert(id, handle);
        self.native_ids.insert(native_id, id);
        Ok(())
    }
}
#[derive(Default)]
struct PressedKeys {
    keys: HashMap<u32, (String, Option<Instant>)>,
}
impl PressedKeys {
    fn press(&mut self, id: u32, action: &str, now: Instant) -> bool {
        if self.keys.contains_key(&id) {
            return false;
        }
        let repeat = matches!(
            action,
            "seekBack" | "seekForward" | "volumeUp" | "volumeDown"
        );
        self.keys.insert(
            id,
            (
                action.into(),
                repeat.then_some(now + Duration::from_millis(350)),
            ),
        );
        true
    }
    fn release(&mut self, id: u32) {
        self.keys.remove(&id);
    }
    fn next(&self) -> Option<Instant> {
        self.keys.values().filter_map(|(_, at)| *at).min()
    }
    fn due(&mut self, now: Instant) -> Vec<String> {
        self.keys
            .values_mut()
            .filter_map(|(action, at)| {
                if at.is_some_and(|at| at <= now) {
                    *at = Some(now + Duration::from_millis(90));
                    Some(action.clone())
                } else {
                    None
                }
            })
            .collect()
    }
}
#[derive(Default)]
struct State {
    registrar: MacRegistrar,
    active: HashMap<i32, ActiveBinding>,
    pressed: PressedKeys,
    handler: usize,
    show_key: usize,
    show_pressed: bool,
    error: Option<String>,
    show_error: Option<String>,
}
fn state() -> &'static Mutex<State> {
    STATE.get_or_init(|| Mutex::new(State::default()))
}

pub fn start(app: AppHandle) {
    if APP.set(app.clone()).is_err() {
        return;
    }
    let _ = app.run_on_main_thread(|| {
        let Ok(mut state) = state().lock() else {
            return;
        };
        match carbon::install(callback) {
            Ok(handle) => state.handler = handle,
            Err(code) => {
                state.error = Some(format!("全局快捷键服务未能启动（{code}）"));
                return;
            }
        }
        match carbon::register(12, 3, SHOW_ID) {
            Ok(handle) => state.show_key = handle,
            Err(_) => state.show_error = Some("Ctrl + Option + Q 已被系统或其他应用占用".into()),
        }
    });
    let _ = std::thread::Builder::new()
        .name("mac-hotkey-repeat".into())
        .spawn(repeat_worker);
}

pub async fn apply(bindings: Vec<GlobalBinding>) -> Result<Registration, String> {
    let app = APP.get().ok_or("全局快捷键服务尚未启动")?;
    let (send, receive) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        if send.is_closed() {
            return;
        }
        let result = (|| {
            let mut state = state()
                .lock()
                .map_err(|_| "全局快捷键服务暂不可用".to_owned())?;
            if let Some(error) = &state.error {
                return Err(error.clone());
            }
            if state.handler == 0 {
                return Err("全局快捷键服务尚未就绪，请重试".into());
            }
            state.pressed = PressedKeys::default();
            WAKE.notify_one();
            let (active, mut result) =
                registry::replace_for(&bindings, &mut state.registrar, Platform::Mac);
            state.active = active;
            if let Some(error) = &state.show_error {
                result.errors.push(BindingError {
                    action: "show".into(),
                    message: error.clone(),
                });
            }
            Ok(result)
        })();
        let _ = send.send(result);
    })
    .map_err(|_| "无法切换全局快捷键，请重试")?;
    tokio::time::timeout(Duration::from_secs(5), receive)
        .await
        .map_err(|_| "全局快捷键设置超时，请重试")?
        .map_err(|_| "全局快捷键服务已停止")?
}

unsafe extern "C" fn callback(_next: *mut c_void, event: *mut c_void, _data: *mut c_void) -> i32 {
    let Some((id, kind)) = carbon::decode(event) else {
        return -9874;
    };
    let Ok(mut state) = state().lock() else {
        return -9874;
    };
    if id == SHOW_ID {
        if kind == carbon::RELEASED {
            state.show_pressed = false;
            return 0;
        }
        if kind != carbon::PRESSED || state.show_pressed {
            return 0;
        }
        state.show_pressed = true;
        drop(state);
        if let Some(app) = APP.get() {
            crate::show_main_window(app);
        }
        return 0;
    }
    if kind == carbon::RELEASED {
        state.pressed.release(id);
        WAKE.notify_one();
        return 0;
    }
    if kind != carbon::PRESSED {
        return 0;
    }
    let Some(logical_id) = state.registrar.native_ids.get(&id).copied() else {
        return 0;
    };
    let Some(action) = state
        .active
        .get(&logical_id)
        .map(|binding| binding.action.clone())
    else {
        return 0;
    };
    if state.pressed.press(id, &action, Instant::now()) {
        if let Some(app) = APP.get() {
            let _ = app.emit_to("main", "global-shortcut", action);
        }
        WAKE.notify_one();
    }
    0
}

fn repeat_worker() {
    let Ok(mut state) = state().lock() else {
        return;
    };
    loop {
        let Some(next) = state.pressed.next() else {
            let Ok(ready) = WAKE.wait(state) else { return };
            state = ready;
            continue;
        };
        let now = Instant::now();
        if next > now {
            let Ok((ready, _)) = WAKE.wait_timeout(state, next - now) else {
                return;
            };
            state = ready;
            continue;
        }
        for action in state.pressed.due(now) {
            if let Some(app) = APP.get() {
                let _ = app.emit_to("main", "global-shortcut", action);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn toggle_never_repeats_and_seek_repeats_stop_on_release_or_reregistration() {
        let now = Instant::now();
        let mut held = PressedKeys::default();
        assert!(held.press(1, "toggle", now));
        assert!(!held.press(1, "toggle", now));
        assert!(held.due(now + Duration::from_secs(2)).is_empty());
        assert!(held.press(2, "seekForward", now));
        assert!(held.due(now + Duration::from_millis(349)).is_empty());
        assert_eq!(held.due(now + Duration::from_millis(350)), ["seekForward"]);
        assert!(held.due(now + Duration::from_millis(400)).is_empty());
        assert_eq!(held.due(now + Duration::from_millis(450)), ["seekForward"]);
        held.release(2);
        assert!(held.next().is_none());
        held.press(3, "volumeUp", now);
        held = PressedKeys::default();
        assert!(held.due(now + Duration::from_secs(1)).is_empty());
    }
    #[test]
    fn carbon_modifiers_ignore_the_windows_repeat_flag() {
        assert_eq!(carbon::modifiers(3), 4096 | 2048);
        assert_eq!(carbon::modifiers(8 | 4 | 0x4000), 256 | 512);
    }
}
