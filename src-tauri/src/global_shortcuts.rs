mod registry;
use registry::Registration;
use serde::Deserialize;
use tauri::AppHandle;
#[cfg(target_os = "macos")]
mod macos;

#[derive(Clone, Deserialize)]
pub struct GlobalBinding {
    action: String,
    code: String,
    ctrl: bool,
    alt: bool,
    shift: bool,
    meta: bool,
}

pub fn start(app: AppHandle) {
    #[cfg(windows)]
    windows::start(app);
    #[cfg(target_os = "macos")]
    macos::start(app);
    #[cfg(not(any(windows, target_os = "macos")))]
    let _ = app;
}

#[tauri::command]
pub async fn global_shortcuts_apply(
    bindings: Vec<GlobalBinding>,
    enabled: bool,
) -> Result<Registration, String> {
    #[cfg(windows)]
    {
        windows::apply(if enabled { bindings } else { vec![] }).await
    }
    #[cfg(target_os = "macos")]
    {
        macos::apply(if enabled { bindings } else { vec![] }).await
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = (bindings, enabled);
        Err("当前系统仅支持窗口内快捷键".into())
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use registry::{ActiveBinding, Registrar};
    use std::{
        collections::{HashMap, VecDeque},
        ffi::c_void,
        os::windows::process::CommandExt,
        sync::{
            Mutex, OnceLock,
            atomic::{AtomicBool, AtomicU32, Ordering},
        },
    };
    use tauri::Emitter;

    struct Request {
        bindings: Vec<GlobalBinding>,
        reply: tokio::sync::oneshot::Sender<Registration>,
    }
    static PENDING: Mutex<VecDeque<Request>> = Mutex::new(VecDeque::new());
    static THREAD: AtomicU32 = AtomicU32::new(0);
    static AVAILABLE: AtomicBool = AtomicBool::new(false);
    static APP: OnceLock<AppHandle> = OnceLock::new();

    pub fn start(app: AppHandle) {
        let _ = APP.set(app);
        let started = std::thread::Builder::new()
            .name("global-shortcuts".into())
            .spawn(|| {
                // A development build must never replace an installed Start Menu shortcut.
                #[cfg(not(debug_assertions))]
                install_launch_shortcut();
                pump();
            });
        AVAILABLE.store(started.is_ok(), Ordering::Release);
    }

    pub async fn apply(bindings: Vec<GlobalBinding>) -> Result<Registration, String> {
        if !AVAILABLE.load(Ordering::Acquire) {
            return Err("全局快捷键服务未能启动，请重启应用".into());
        }
        let (reply, receive) = tokio::sync::oneshot::channel();
        PENDING
            .lock()
            .map_err(|_| "全局快捷键服务暂不可用")?
            .push_back(Request { bindings, reply });
        let id = THREAD.load(Ordering::Acquire);
        if id != 0 {
            unsafe {
                PostThreadMessageW(id, WM_APP, 0, 0);
            }
        }
        tokio::time::timeout(std::time::Duration::from_secs(5), receive)
            .await
            .map_err(|_| "全局快捷键设置超时，请重试".to_owned())?
            .map_err(|_| "全局快捷键服务已停止，请重启应用".into())
    }

    #[cfg(not(debug_assertions))]
    fn install_launch_shortcut() {
        let Ok(exe) = std::env::current_exe() else {
            return;
        };
        let Some(appdata) = std::env::var_os("APPDATA") else {
            return;
        };
        let lnk = std::path::PathBuf::from(appdata)
            .join(r"Microsoft\Windows\Start Menu\Programs\BiliMusic.lnk");
        // Explorer can launch this shortcut after the application exits; the existing
        // single-instance plugin brings an already running main window to the front.
        let _=std::process::Command::new("powershell.exe").args([
            "-NoProfile","-NonInteractive","-WindowStyle","Hidden","-Command",
            "$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:BILIMUSIC_LNK); $s.TargetPath=$env:BILIMUSIC_EXE; $s.WorkingDirectory=(Split-Path $env:BILIMUSIC_EXE); $s.Hotkey='CTRL+ALT+Q'; $s.Save()",
        ]).env("BILIMUSIC_LNK",lnk).env("BILIMUSIC_EXE",exe).creation_flags(0x08000000).spawn();
    }

    const WM_HOTKEY: u32 = 0x0312;
    const WM_APP: u32 = 0x8000;
    #[repr(C)]
    struct Point {
        x: i32,
        y: i32,
    }
    #[repr(C)]
    struct Msg {
        hwnd: *mut c_void,
        message: u32,
        w_param: usize,
        l_param: isize,
        time: u32,
        pt: Point,
        private: u32,
    }
    #[cfg(target_pointer_width = "64")]
    const _: () = assert!(std::mem::size_of::<Msg>() == 48);
    #[cfg(target_pointer_width = "32")]
    const _: () = assert!(std::mem::size_of::<Msg>() == 32);
    #[link(name = "user32")]
    unsafe extern "system" {
        fn RegisterHotKey(hwnd: *mut c_void, id: i32, modifiers: u32, vk: u32) -> i32;
        fn UnregisterHotKey(hwnd: *mut c_void, id: i32) -> i32;
        fn PeekMessageW(msg: *mut Msg, hwnd: *mut c_void, min: u32, max: u32, remove: u32) -> i32;
        fn GetMessageW(msg: *mut Msg, hwnd: *mut c_void, min: u32, max: u32) -> i32;
        fn PostThreadMessageW(id: u32, msg: u32, w_param: usize, l_param: isize) -> i32;
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentThreadId() -> u32;
        fn GetLastError() -> u32;
    }
    struct SystemRegistrar;
    impl Registrar for SystemRegistrar {
        fn unregister(&mut self, id: i32) {
            unsafe {
                UnregisterHotKey(std::ptr::null_mut(), id);
            }
        }
        fn register(&mut self, id: i32, modifiers: u32, key: u32) -> Result<(), u32> {
            if unsafe { RegisterHotKey(std::ptr::null_mut(), id, modifiers, key) } != 0 {
                Ok(())
            } else {
                Err(unsafe { GetLastError() })
            }
        }
    }
    fn update(active: &mut HashMap<i32, ActiveBinding>) {
        loop {
            let request = PENDING
                .lock()
                .ok()
                .and_then(|mut pending| pending.pop_front());
            let Some(request) = request else { break };
            if request.reply.is_closed() {
                continue;
            }
            let (next, result) = registry::replace(&request.bindings, &mut SystemRegistrar);
            *active = next;
            let _ = request.reply.send(result);
        }
    }
    fn pump() {
        unsafe {
            let mut msg = std::mem::zeroed::<Msg>();
            PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, 0);
            THREAD.store(GetCurrentThreadId(), Ordering::Release);
            let mut active = HashMap::new();
            update(&mut active);
            while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                if msg.message == WM_APP {
                    update(&mut active);
                } else if msg.message == WM_HOTKEY {
                    if let Some(binding) = active.get(&(msg.w_param as i32)) {
                        // Discard messages queued for a replaced binding using the same id.
                        if binding.matches_message(msg.l_param) {
                            if let Some(app) = APP.get() {
                                let _ = app.emit_to("main", "global-shortcut", &binding.action);
                            }
                        }
                    }
                }
            }
            AVAILABLE.store(false, Ordering::Release);
        }
    }
}
