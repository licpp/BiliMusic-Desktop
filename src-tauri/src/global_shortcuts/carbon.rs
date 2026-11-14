//! Carbon's registered hotkeys do not require an accessibility event tap.
//! Registration and callbacks run on the application's main event loop.
use std::ffi::c_void;

pub const SIGNATURE: u32 = u32::from_be_bytes(*b"BMuS");
pub const PRESSED: u32 = 5;
pub const RELEASED: u32 = 6;
pub type Handler = unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void) -> i32;
#[repr(C)]
#[derive(Default)]
struct HotkeyId {
    signature: u32,
    id: u32,
}
#[repr(C)]
struct EventType {
    class: u32,
    kind: u32,
}
#[link(name = "Carbon", kind = "framework")]
unsafe extern "C" {
    fn GetApplicationEventTarget() -> *mut c_void;
    fn RegisterEventHotKey(
        key: u32,
        modifiers: u32,
        id: HotkeyId,
        target: *mut c_void,
        options: u32,
        result: *mut *mut c_void,
    ) -> i32;
    fn UnregisterEventHotKey(key: *mut c_void) -> i32;
    fn InstallEventHandler(
        target: *mut c_void,
        handler: Option<Handler>,
        count: u32,
        types: *const EventType,
        data: *mut c_void,
        result: *mut *mut c_void,
    ) -> i32;
    fn GetEventParameter(
        event: *mut c_void,
        name: u32,
        kind: u32,
        actual_type: *mut u32,
        size: u32,
        actual_size: *mut u32,
        result: *mut c_void,
    ) -> i32;
    fn GetEventKind(event: *mut c_void) -> u32;
}

pub fn modifiers(normalized: u32) -> u32 {
    (if normalized & 1 != 0 { 1 << 11 } else { 0 })
        | (if normalized & 2 != 0 { 1 << 12 } else { 0 })
        | (if normalized & 4 != 0 { 1 << 9 } else { 0 })
        | (if normalized & 8 != 0 { 1 << 8 } else { 0 })
}
pub fn register(key: u32, normalized: u32, id: u32) -> Result<usize, i32> {
    let mut handle = std::ptr::null_mut();
    // Exclusive registration reports a collision rather than silently accepting
    // a combination already owned by another application.
    let status = unsafe {
        RegisterEventHotKey(
            key,
            modifiers(normalized),
            HotkeyId {
                signature: SIGNATURE,
                id,
            },
            GetApplicationEventTarget(),
            1,
            &mut handle,
        )
    };
    if status == 0 {
        Ok(handle as usize)
    } else {
        Err(status)
    }
}
pub fn unregister(handle: usize) {
    if handle != 0 {
        unsafe {
            UnregisterEventHotKey(handle as *mut c_void);
        }
    }
}
pub fn install(handler: Handler) -> Result<usize, i32> {
    let events = [
        EventType {
            class: u32::from_be_bytes(*b"keyb"),
            kind: PRESSED,
        },
        EventType {
            class: u32::from_be_bytes(*b"keyb"),
            kind: RELEASED,
        },
    ];
    let mut handle = std::ptr::null_mut();
    let status = unsafe {
        InstallEventHandler(
            GetApplicationEventTarget(),
            Some(handler),
            2,
            events.as_ptr(),
            std::ptr::null_mut(),
            &mut handle,
        )
    };
    if status == 0 {
        Ok(handle as usize)
    } else {
        Err(status)
    }
}
pub fn decode(event: *mut c_void) -> Option<(u32, u32)> {
    let mut id = HotkeyId::default();
    let status = unsafe {
        GetEventParameter(
            event,
            u32::from_be_bytes(*b"----"),
            u32::from_be_bytes(*b"hkid"),
            std::ptr::null_mut(),
            std::mem::size_of::<HotkeyId>() as u32,
            std::ptr::null_mut(),
            &mut id as *mut _ as *mut c_void,
        )
    };
    (status == 0 && id.signature == SIGNATURE).then(|| (id.id, unsafe { GetEventKind(event) }))
}
