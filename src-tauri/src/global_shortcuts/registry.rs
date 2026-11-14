use super::GlobalBinding;
use serde::Serialize;
use std::collections::{HashMap, HashSet};

#[derive(Default, Debug, Serialize)]
pub struct Registration {
    pub registered: Vec<String>,
    pub errors: Vec<BindingError>,
}

#[derive(Debug, Serialize)]
pub struct BindingError {
    pub action: String,
    pub message: String,
}

pub struct ActiveBinding {
    pub action: String,
    pub modifiers: u32,
    pub key: u32,
}

impl ActiveBinding {
    pub fn matches_message(&self, parameter: isize) -> bool {
        self.modifiers == parameter as u32 & 0xf && self.key == (parameter as u32 >> 16) & 0xffff
    }
}

pub trait Registrar {
    fn unregister(&mut self, id: i32);
    fn register(&mut self, id: i32, modifiers: u32, key: u32) -> Result<(), u32>;
}

#[derive(Clone, Copy)]
pub enum Platform {
    Windows,
    Mac,
}

pub fn replace(
    bindings: &[GlobalBinding],
    registrar: &mut impl Registrar,
) -> (HashMap<i32, ActiveBinding>, Registration) {
    replace_for(bindings, registrar, Platform::Windows)
}

pub fn replace_for(
    bindings: &[GlobalBinding],
    registrar: &mut impl Registrar,
    platform: Platform,
) -> (HashMap<i32, ActiveBinding>, Registration) {
    for id in 1..=16 {
        registrar.unregister(id);
    }
    let mut active = HashMap::new();
    let mut result = Registration::default();
    let mut keys = HashSet::new();
    let mut actions = HashSet::new();
    for binding in bindings.iter().take(16) {
        let modifiers = u32::from(binding.alt)
            | (u32::from(binding.ctrl) << 1)
            | (u32::from(binding.shift) << 2)
            | (u32::from(binding.meta) << 3);
        let key = match platform {
            Platform::Windows => virtual_key(&binding.code),
            Platform::Mac => mac_key(&binding.code),
        };
        let error = if !matches!(
            binding.action.as_str(),
            "toggle" | "previous" | "next" | "seekBack" | "seekForward" | "volumeUp" | "volumeDown"
        ) || binding.code == "Space"
            || key.is_none()
            || (modifiers == 0
                && !binding
                    .code
                    .strip_prefix('F')
                    .and_then(|v| v.parse::<u32>().ok())
                    .is_some_and(|v| (1..=12).contains(&v)))
            || (binding.code == "KeyQ" && modifiers == 3)
        {
            Some("此按键不能注册为全局播放快捷键".to_owned())
        } else if !actions.insert(binding.action.clone()) || !keys.insert((modifiers, key.unwrap()))
        {
            Some("此全局快捷键与另一项设置冲突".to_owned())
        } else {
            let key = key.unwrap();
            let id = active.len() as i32 + 1;
            let no_repeat = if matches!(binding.action.as_str(), "toggle" | "previous" | "next") {
                0x4000
            } else {
                0
            };
            match registrar.register(id, modifiers | no_repeat, key) {
                Ok(()) => {
                    active.insert(
                        id,
                        ActiveBinding {
                            action: binding.action.clone(),
                            modifiers,
                            key,
                        },
                    );
                    result.registered.push(binding.action.clone());
                    None
                }
                Err(code) if code == 1409 || code == (-9878i32) as u32 => {
                    Some("此快捷键已被系统或其他应用占用，请换一个组合".to_owned())
                }
                Err(code) => Some(format!("无法注册此快捷键（系统错误 {code}），请换一个组合")),
            }
        };
        if let Some(message) = error {
            result.errors.push(BindingError {
                action: binding.action.clone(),
                message,
            });
        }
    }
    (active, result)
}

// macOS virtual key codes are physical ANSI keyboard positions, rather than
// Windows VK values. Keypad Enter is a separate key on macOS.
fn mac_key(code: &str) -> Option<u32> {
    Some(match code {
        "KeyA" => 0,
        "KeyS" => 1,
        "KeyD" => 2,
        "KeyF" => 3,
        "KeyH" => 4,
        "KeyG" => 5,
        "KeyZ" => 6,
        "KeyX" => 7,
        "KeyC" => 8,
        "KeyV" => 9,
        "KeyB" => 11,
        "KeyQ" => 12,
        "KeyW" => 13,
        "KeyE" => 14,
        "KeyR" => 15,
        "KeyY" => 16,
        "KeyT" => 17,
        "Digit1" => 18,
        "Digit2" => 19,
        "Digit3" => 20,
        "Digit4" => 21,
        "Digit6" => 22,
        "Digit5" => 23,
        "Equal" => 24,
        "Digit9" => 25,
        "Digit7" => 26,
        "Minus" => 27,
        "Digit8" => 28,
        "Digit0" => 29,
        "BracketRight" => 30,
        "KeyO" => 31,
        "KeyU" => 32,
        "BracketLeft" => 33,
        "KeyI" => 34,
        "KeyP" => 35,
        "Enter" => 36,
        "KeyL" => 37,
        "KeyJ" => 38,
        "Quote" => 39,
        "KeyK" => 40,
        "Semicolon" => 41,
        "Backslash" => 42,
        "Comma" => 43,
        "Slash" => 44,
        "KeyN" => 45,
        "KeyM" => 46,
        "Period" => 47,
        "Backquote" => 50,
        "Backspace" => 51,
        "NumpadDecimal" => 65,
        "NumpadMultiply" => 67,
        "NumpadAdd" => 69,
        "NumpadDivide" => 75,
        "NumpadEnter" => 76,
        "NumpadSubtract" => 78,
        "Numpad0" => 82,
        "Numpad1" => 83,
        "Numpad2" => 84,
        "Numpad3" => 85,
        "Numpad4" => 86,
        "Numpad5" => 87,
        "Numpad6" => 88,
        "Numpad7" => 89,
        "Numpad8" => 91,
        "Numpad9" => 92,
        "F5" => 96,
        "F6" => 97,
        "F7" => 98,
        "F3" => 99,
        "F8" => 100,
        "F9" => 101,
        "F11" => 103,
        "F10" => 109,
        "F12" => 111,
        "Home" => 115,
        "PageUp" => 116,
        "Delete" => 117,
        "F4" => 118,
        "End" => 119,
        "F2" => 120,
        "PageDown" => 121,
        "F1" => 122,
        "ArrowLeft" => 123,
        "ArrowRight" => 124,
        "ArrowDown" => 125,
        "ArrowUp" => 126,
        _ => return None,
    })
}

fn virtual_key(code: &str) -> Option<u32> {
    if let Some(letter) = code.strip_prefix("Key").filter(|value| value.len() == 1) {
        return letter
            .chars()
            .next()
            .filter(|c| c.is_ascii_uppercase())
            .map(|c| c as u32);
    }
    if let Some(digit) = code.strip_prefix("Digit").filter(|value| value.len() == 1) {
        return digit
            .parse::<u32>()
            .ok()
            .filter(|n| *n <= 9)
            .map(|n| 0x30 + n);
    }
    if let Some(digit) = code.strip_prefix("Numpad").filter(|value| value.len() == 1) {
        return digit
            .parse::<u32>()
            .ok()
            .filter(|n| *n <= 9)
            .map(|n| 0x60 + n);
    }
    if let Some(f) = code.strip_prefix('F') {
        return f
            .parse::<u32>()
            .ok()
            .filter(|n| (1..=12).contains(n))
            .map(|n| 0x6f + n);
    }
    Some(match code {
        "ArrowLeft" => 0x25,
        "ArrowUp" => 0x26,
        "ArrowRight" => 0x27,
        "ArrowDown" => 0x28,
        "Enter" | "NumpadEnter" => 0x0d,
        "Backspace" => 0x08,
        "Delete" => 0x2e,
        "Home" => 0x24,
        "End" => 0x23,
        "PageUp" => 0x21,
        "PageDown" => 0x22,
        "Insert" => 0x2d,
        "Minus" => 0xbd,
        "Equal" => 0xbb,
        "Comma" => 0xbc,
        "Period" => 0xbe,
        "Slash" => 0xbf,
        "Semicolon" => 0xba,
        "Quote" => 0xde,
        "BracketLeft" => 0xdb,
        "BracketRight" => 0xdd,
        "Backslash" => 0xdc,
        "Backquote" => 0xc0,
        "NumpadAdd" => 0x6b,
        "NumpadSubtract" => 0x6d,
        "NumpadMultiply" => 0x6a,
        "NumpadDivide" => 0x6f,
        "NumpadDecimal" => 0x6e,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Default)]
    struct Fake {
        removed: Vec<i32>,
        registered: Vec<(i32, u32, u32)>,
    }
    impl Registrar for Fake {
        fn unregister(&mut self, id: i32) {
            self.removed.push(id);
        }
        fn register(&mut self, id: i32, modifiers: u32, key: u32) -> Result<(), u32> {
            if key == 0x25 {
                return Err(1409);
            }
            self.registered.push((id, modifiers, key));
            Ok(())
        }
    }
    fn binding(action: &str, code: &str) -> GlobalBinding {
        GlobalBinding {
            action: action.into(),
            code: code.into(),
            ctrl: true,
            alt: false,
            shift: false,
            meta: false,
        }
    }
    #[test]
    fn failed_os_registration_is_reported_without_misrouting_successful_actions() {
        let mut os = Fake::default();
        let (active, result) = replace(
            &[
                binding("previous", "ArrowLeft"),
                binding("next", "ArrowRight"),
                binding("volumeUp", "ArrowUp"),
            ],
            &mut os,
        );
        assert_eq!(result.registered, ["next", "volumeUp"]);
        assert_eq!(result.errors[0].action, "previous");
        assert!(result.errors[0].message.contains("占用"));
        assert_eq!(active[&1].action, "next");
        assert_eq!((active[&1].modifiers, active[&1].key), (2, 0x27));
        assert!(active[&1].matches_message((0x27 << 16) | 2));
        assert!(active[&1].matches_message((0x27 << 16) | 2 | 0x4000));
        assert!(!active[&1].matches_message((0x25 << 16) | 2));
        assert_ne!(os.registered[0].1 & 0x4000, 0);
        assert_eq!(os.registered[1].1 & 0x4000, 0);
        assert_eq!(os.removed.len(), 16);
    }
    #[test]
    fn physical_enter_aliases_conflict_but_distinct_numpad_digits_do_not() {
        let mut os = Fake::default();
        let (_, result) = replace(
            &[
                binding("toggle", "Enter"),
                binding("next", "NumpadEnter"),
                binding("previous", "Digit1"),
                binding("volumeUp", "Numpad1"),
            ],
            &mut os,
        );
        assert_eq!(result.registered, ["toggle", "previous", "volumeUp"]);
        assert_eq!(result.errors[0].action, "next");
    }
    #[test]
    fn mac_uses_physical_codes_and_keeps_enter_keys_distinct() {
        let mut os = Fake::default();
        let (active, result) = replace_for(
            &[
                binding("toggle", "Enter"),
                binding("next", "NumpadEnter"),
                binding("previous", "KeyA"),
            ],
            &mut os,
            Platform::Mac,
        );
        assert!(result.errors.is_empty());
        assert_eq!(result.registered, ["toggle", "next", "previous"]);
        assert_eq!(
            (active[&1].key, active[&2].key, active[&3].key),
            (36, 76, 0)
        );
        assert_eq!(mac_key("ArrowRight"), Some(124));
        assert_eq!(mac_key("F12"), Some(111));
        assert_eq!(mac_key("Insert"), None);
        let mut bare = binding("toggle", "KeyA");
        bare.ctrl = false;
        let (_, result) = replace_for(&[bare], &mut os, Platform::Mac);
        assert_eq!(result.errors.len(), 1);
    }
    #[test]
    fn disabling_unregisters_all_and_unsafe_inputs_never_reach_the_os() {
        let mut os = Fake::default();
        let mut bare = binding("toggle", "KeyA");
        bare.ctrl = false;
        let mut launch = binding("next", "KeyQ");
        launch.alt = true;
        let (active, result) = replace(
            &[
                bare,
                launch,
                binding("toggle", "Space"),
                binding("listSearch", "KeyF"),
                binding("next", "MouseBack"),
            ],
            &mut os,
        );
        assert!(active.is_empty());
        assert_eq!(result.errors.len(), 5);
        assert!(os.registered.is_empty());
        let (active, result) = replace(&[], &mut os);
        assert!(active.is_empty());
        assert!(result.errors.is_empty());
        assert_eq!(os.removed.len(), 32);
    }
}
