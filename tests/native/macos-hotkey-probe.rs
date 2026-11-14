//! Run on the process main thread; no accessibility permission or physical key
//! injection is needed. Exercise production Carbon FFI and synthetic hotkey events.
#[path = "../../src-tauri/src/global_shortcuts/carbon.rs"]
mod carbon;
use std::{
    ffi::c_void,
    sync::atomic::{AtomicUsize, Ordering},
};
static PRESSES: AtomicUsize = AtomicUsize::new(0);
static RELEASES: AtomicUsize = AtomicUsize::new(0);
unsafe extern "C" fn handler(_next: *mut c_void, event: *mut c_void, _data: *mut c_void) -> i32 {
    if let Some((id, kind)) = carbon::decode(event) {
        assert_eq!(id, 42);
        if kind == carbon::PRESSED {
            PRESSES.fetch_add(1, Ordering::Relaxed);
        }
        if kind == carbon::RELEASED {
            RELEASES.fetch_add(1, Ordering::Relaxed);
        }
        0
    } else {
        -9874
    }
}
#[repr(C)]
struct HotkeyId {
    signature: u32,
    id: u32,
}
#[link(name = "Carbon", kind = "framework")]
unsafe extern "C" {
    fn GetApplicationEventTarget() -> *mut c_void;
    fn CreateEvent(
        allocator: *const c_void,
        class: u32,
        kind: u32,
        time: f64,
        attributes: u32,
        result: *mut *mut c_void,
    ) -> i32;
    fn SetEventParameter(
        event: *mut c_void,
        name: u32,
        kind: u32,
        size: u32,
        value: *const c_void,
    ) -> i32;
    fn SendEventToEventTarget(event: *mut c_void, target: *mut c_void) -> i32;
    fn ReleaseEvent(event: *mut c_void);
    fn RemoveEventHandler(handler: *mut c_void) -> i32;
}
fn main() {
    let installed = carbon::install(handler).expect("install production Carbon handler");
    let first = carbon::register(103, 15, 42).expect("register Cmd+Ctrl+Option+Shift+F11");
    assert_eq!(
        carbon::register(103, 15, 43).unwrap_err(),
        -9878,
        "exclusive conflicts must be reported"
    );
    for kind in [carbon::PRESSED, carbon::RELEASED] {
        unsafe {
            let mut event = std::ptr::null_mut();
            assert_eq!(
                CreateEvent(
                    std::ptr::null(),
                    u32::from_be_bytes(*b"keyb"),
                    kind,
                    0.0,
                    0,
                    &mut event
                ),
                0
            );
            let id = HotkeyId {
                signature: carbon::SIGNATURE,
                id: 42,
            };
            assert_eq!(
                SetEventParameter(
                    event,
                    u32::from_be_bytes(*b"----"),
                    u32::from_be_bytes(*b"hkid"),
                    8,
                    &id as *const _ as *const c_void
                ),
                0
            );
            assert_eq!(
                SendEventToEventTarget(event, GetApplicationEventTarget()),
                0
            );
            ReleaseEvent(event);
        }
    }
    assert_eq!(PRESSES.load(Ordering::Relaxed), 1);
    assert_eq!(RELEASES.load(Ordering::Relaxed), 1);
    carbon::unregister(first);
    let next = carbon::register(103, 15, 44).expect("unregister releases system reservation");
    carbon::unregister(next);
    unsafe {
        assert_eq!(RemoveEventHandler(installed as *mut c_void), 0);
    }
    println!("Carbon registration, collision, pressed/released delivery and cleanup passed");
}
