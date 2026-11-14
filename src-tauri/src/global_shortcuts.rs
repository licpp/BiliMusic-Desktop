use serde::Deserialize;
#[cfg(windows)]
use std::ffi::c_void;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::AppHandle;
#[cfg(windows)]
use tauri::Emitter;

#[derive(Clone, Deserialize)]
pub struct GlobalBinding {
    action: String,
    code: String,
    ctrl: bool,
    alt: bool,
    shift: bool,
    meta: bool,
}

static APP: OnceLock<AppHandle> = OnceLock::new();
static PENDING: Mutex<Vec<GlobalBinding>> = Mutex::new(Vec::new());
#[cfg(windows)]
static ACTIONS: Mutex<Vec<String>> = Mutex::new(Vec::new());
#[cfg(windows)]
static THREAD: AtomicU32 = AtomicU32::new(0);

pub fn start(app: AppHandle) {
    let _ = APP.set(app);
    #[cfg(windows)]
    {
        let _ = std::thread::Builder::new()
            .name("global-shortcuts".into())
            .spawn(|| {
                install_launch_shortcut();
                pump();
            });
    }
}

pub fn apply(bindings: Vec<GlobalBinding>) {
    if let Ok(mut pending) = PENDING.lock() {
        *pending = bindings;
    }
    #[cfg(windows)]
    {
        let id = THREAD.load(Ordering::Acquire);
        if id != 0 {
            unsafe {
                PostThreadMessageW(id, WM_APP, 0, 0);
            }
        }
    }
}

#[cfg(windows)]
fn install_launch_shortcut() {
    // ponytail: a Start Menu .lnk hotkey still launches after the process exits.
    // An in-process hotkey cannot. macOS has no equivalent without a resident helper.
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let Some(appdata) = std::env::var_os("APPDATA") else {
        return;
    };
    let lnk = std::path::PathBuf::from(appdata)
        .join(r"Microsoft\Windows\Start Menu\Programs\BiliMusic.lnk");
    let _ = std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            "$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:BILIMUSIC_LNK); $s.TargetPath=$env:BILIMUSIC_EXE; $s.WorkingDirectory=(Split-Path $env:BILIMUSIC_EXE); $s.Hotkey='CTRL+ALT+Q'; $s.Save()",
        ])
        .env("BILIMUSIC_LNK", &lnk)
        .env("BILIMUSIC_EXE", &exe)
        .creation_flags(0x08000000)
        .spawn();
}

#[cfg(windows)]
const WM_HOTKEY: u32 = 0x0312;
#[cfg(windows)]
const WM_APP: u32 = 0x8000;
#[cfg(windows)]
const MOD_ALT: u32 = 0x0001;
#[cfg(windows)]
const MOD_CONTROL: u32 = 0x0002;
#[cfg(windows)]
const MOD_SHIFT: u32 = 0x0004;
#[cfg(windows)]
const MOD_WIN: u32 = 0x0008;
#[cfg(windows)]
const MOD_NOREPEAT: u32 = 0x4000;

#[cfg(windows)]
#[repr(C)]
struct Point {
    x: i32,
    y: i32,
}
#[cfg(windows)]
#[repr(C)]
struct Msg {
    hwnd: *mut c_void,
    message: u32,
    w_param: usize,
    l_param: isize,
    time: u32,
    pt: Point,
}
#[cfg(all(windows, target_pointer_width = "64"))]
const _: () = assert!(std::mem::size_of::<Msg>() == 48);

#[cfg(windows)]
#[link(name = "user32")]
unsafe extern "system" {
    fn RegisterHotKey(hwnd: *mut c_void, id: i32, modifiers: u32, vk: u32) -> i32;
    fn UnregisterHotKey(hwnd: *mut c_void, id: i32) -> i32;
    fn PeekMessageW(msg: *mut Msg, hwnd: *mut c_void, min: u32, max: u32, remove: u32) -> i32;
    fn GetMessageW(msg: *mut Msg, hwnd: *mut c_void, min: u32, max: u32) -> i32;
    fn PostThreadMessageW(id: u32, msg: u32, w_param: usize, l_param: isize) -> i32;
    fn GetCurrentThreadId() -> u32;
}

#[cfg(windows)]
fn virtual_key(code: &str) -> Option<u32> {
    if let Some(letter) = code.strip_prefix("Key").filter(|letter| letter.len() == 1) {
        return letter
            .chars()
            .next()
            .filter(|c| c.is_ascii_uppercase())
            .map(|c| c as u32);
    }
    if let Some(digit) = code.strip_prefix("Digit") {
        return digit
            .parse::<u32>()
            .ok()
            .filter(|n| *n <= 9)
            .map(|n| 0x30 + n);
    }
    if let Some(digit) = code
        .strip_prefix("Numpad")
        .filter(|digit| digit.len() == 1 && digit.chars().all(|c| c.is_ascii_digit()))
    {
        return digit.parse::<u32>().ok().map(|n| 0x60 + n);
    }
    if let Some(f) = code.strip_prefix('F') {
        return f
            .parse::<u32>()
            .ok()
            .filter(|n| (1..=12).contains(n))
            .map(|n| 0x6F + n);
    }
    Some(match code {
        "ArrowLeft" => 0x25,
        "ArrowUp" => 0x26,
        "ArrowRight" => 0x27,
        "ArrowDown" => 0x28,
        "Space" => 0x20,
        "Enter" | "NumpadEnter" => 0x0D,
        "Backspace" => 0x08,
        "Delete" => 0x2E,
        "Home" => 0x24,
        "End" => 0x23,
        "PageUp" => 0x21,
        "PageDown" => 0x22,
        "Insert" => 0x2D,
        "Minus" => 0xBD,
        "Equal" => 0xBB,
        "Comma" => 0xBC,
        "Period" => 0xBE,
        "Slash" => 0xBF,
        "Semicolon" => 0xBA,
        "Quote" => 0xDE,
        "BracketLeft" => 0xDB,
        "BracketRight" => 0xDD,
        "Backslash" => 0xDC,
        "Backquote" => 0xC0,
        "NumpadAdd" => 0x6B,
        "NumpadSubtract" => 0x6D,
        "NumpadMultiply" => 0x6A,
        "NumpadDivide" => 0x6F,
        "NumpadDecimal" => 0x6E,
        _ => return None,
    })
}

#[cfg(windows)]
fn reregister() {
    let bindings = PENDING
        .lock()
        .map(|pending| pending.clone())
        .unwrap_or_default();
    let mut actions = Vec::new();
    unsafe {
        for id in 1..=16 {
            UnregisterHotKey(std::ptr::null_mut(), id);
        }
        for binding in bindings {
            let Some(vk) = virtual_key(&binding.code) else {
                continue;
            };
            let mut modifiers = 0;
            if !matches!(
                binding.action.as_str(),
                "seekBack" | "seekForward" | "volumeUp" | "volumeDown"
            ) {
                modifiers |= MOD_NOREPEAT;
            }
            if binding.alt {
                modifiers |= MOD_ALT
            }
            if binding.ctrl {
                modifiers |= MOD_CONTROL
            }
            if binding.shift {
                modifiers |= MOD_SHIFT
            }
            if binding.meta {
                modifiers |= MOD_WIN
            }
            let id = actions.len() as i32 + 1;
            if id > 16 {
                break;
            }
            if RegisterHotKey(std::ptr::null_mut(), id, modifiers, vk) != 0 {
                actions.push(binding.action);
            }
        }
    }
    if let Ok(mut stored) = ACTIONS.lock() {
        *stored = actions;
    }
}

#[cfg(windows)]
fn pump() {
    unsafe {
        let mut msg = std::mem::zeroed::<Msg>();
        PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, 0);
        reregister();
        THREAD.store(GetCurrentThreadId(), Ordering::Release);
        reregister();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            if msg.message == WM_APP {
                reregister();
            } else if msg.message == WM_HOTKEY {
                let index = msg.w_param.saturating_sub(1);
                let action = ACTIONS
                    .lock()
                    .ok()
                    .and_then(|actions| actions.get(index).cloned());
                if let Some(action) = action {
                    if let Some(app) = APP.get() {
                        let _ = app.emit("global-shortcut", action);
                    }
                }
            }
        }
    }
}

#[tauri::command]
pub fn global_shortcuts_apply(bindings: Vec<GlobalBinding>) {
    apply(bindings);
}
