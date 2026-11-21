use crate::{desktop_media, tray_player::Snapshot};
use image::{DynamicImage, ImageReader, Limits};
use std::{cell::RefCell, io::Cursor, mem::size_of, time::Duration};
use tauri::{AppHandle, Manager};
use windows::{
    Win32::{
        Foundation::{HWND, LPARAM, LRESULT, WPARAM},
        Graphics::{Dwm::*, Gdi::*},
        System::Com::{CLSCTX_INPROC_SERVER, CoCreateInstance},
        UI::{
            HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi},
            Shell::*,
            WindowsAndMessaging::*,
        },
    },
    core::w,
};

mod thumbnail;

const SUBCLASS_ID: usize = 0x424D;
const PREVIOUS: u32 = 0x4241;
const TOGGLE: u32 = 0x4242;
const NEXT: u32 = 0x4243;
const ARTWORK_LIMIT: usize = 4 * 1024 * 1024;

thread_local! {
    static PREVIEW: RefCell<Option<TaskbarPlayer>> = const { RefCell::new(None) };
}

struct TaskbarPlayer {
    app: AppHandle,
    hwnd: HWND,
    button_created: u32,
    toolbar: Option<ITaskbarList3>,
    artwork_request: Option<tauri::async_runtime::JoinHandle<()>>,
    artwork_revision: u64,
    artwork: Option<DynamicImage>,
    logo: Option<DynamicImage>,
    track: Snapshot,
}

pub fn initialize(app: &AppHandle) {
    let Some(hwnd) = app
        .get_webview_window("main")
        .and_then(|window| window.hwnd().ok())
    else {
        return;
    };
    // Tauri creates and owns the HWND. All Shell and DWM calls stay on its UI thread.
    let button_created = unsafe { RegisterWindowMessageW(w!("TaskbarButtonCreated")) };
    if button_created == 0
        || !unsafe { SetWindowSubclass(hwnd, Some(window_message), SUBCLASS_ID, 0) }.as_bool()
    {
        return;
    }
    let mut player = TaskbarPlayer {
        app: app.clone(),
        hwnd,
        button_created,
        toolbar: None,
        artwork_request: None,
        artwork_revision: 0,
        artwork: None,
        logo: decode_artwork(include_bytes!("../icons/128x128.png")),
        track: Snapshot::default(),
    };
    player.register_toolbar();
    PREVIEW.with(|preview| preview.replace(Some(player)));
}

pub fn update(track: &Snapshot) {
    PREVIEW.with(|preview| {
        let Ok(mut preview) = preview.try_borrow_mut() else {
            return;
        };
        let Some(player) = preview.as_mut() else {
            return;
        };
        let presence_changed = player.track.id.is_some() != track.id.is_some();
        let buttons_changed = presence_changed || player.track.playing != track.playing;
        let artwork_changed = player.track.cover_url != track.cover_url || presence_changed;
        let thumbnail_changed = artwork_changed || player.track.theme != track.theme;
        player.track = track.clone();
        if buttons_changed {
            player.update_toolbar();
        }
        if presence_changed {
            player.set_custom_thumbnail(track.id.is_some());
        }
        if artwork_changed {
            player.load_artwork();
        }
        if thumbnail_changed {
            player.invalidate_thumbnail();
        }
    });
}

unsafe extern "system" fn window_message(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _: usize,
    _: usize,
) -> LRESULT {
    if message == WM_NCDESTROY {
        let _ = unsafe { RemoveWindowSubclass(hwnd, Some(window_message), SUBCLASS_ID) };
        PREVIEW.with(|preview| {
            if let Ok(mut preview) = preview.try_borrow_mut()
                && let Some(mut player) = preview.take()
                && let Some(request) = player.artwork_request.take()
            {
                request.abort();
            }
        });
    } else {
        let handled = PREVIEW.with(|preview| {
            let Ok(mut preview) = preview.try_borrow_mut() else {
                return false;
            };
            let Some(player) = preview.as_mut() else {
                return false;
            };
            if message == player.button_created {
                player.register_toolbar();
                true
            } else if message == WM_DPICHANGED {
                player.update_toolbar();
                player.invalidate_thumbnail();
                false
            } else if message == WM_DWMSENDICONICTHUMBNAIL && player.track.id.is_some() {
                let width = ((lparam.0 >> 16) & 0xffff) as u32;
                let height = (lparam.0 & 0xffff) as u32;
                if let Some(bitmap) = player.thumbnail(width, height) {
                    unsafe { DwmSetIconicThumbnail(hwnd, bitmap.0, 0) }.is_ok()
                } else {
                    false
                }
            } else if message == WM_COMMAND && ((wparam.0 >> 16) & 0xffff) as u32 == THBN_CLICKED {
                let action = match (wparam.0 & 0xffff) as u32 {
                    PREVIOUS => "previous",
                    TOGGLE => "toggle",
                    NEXT => "next",
                    _ => return false,
                };
                if player.track.id.is_some() {
                    let _ = desktop_media::emit_action(&player.app, action, 0.);
                }
                true
            } else {
                false
            }
        });
        if handled {
            return LRESULT(0);
        }
    }
    unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
}

impl TaskbarPlayer {
    fn register_toolbar(&mut self) {
        self.toolbar = (|| {
            let toolbar: ITaskbarList3 =
                unsafe { CoCreateInstance(&TaskbarList, None, CLSCTX_INPROC_SERVER) }.ok()?;
            unsafe { toolbar.HrInit() }.ok()?;
            let icons = PlaybackIcons::new(self.hwnd)?;
            let buttons = icons.buttons(&self.track);
            // The taskbar button may already exist when the subclass is installed.
            unsafe { toolbar.ThumbBarAddButtons(self.hwnd, &buttons) }
                .or_else(|_| unsafe { toolbar.ThumbBarUpdateButtons(self.hwnd, &buttons) })
                .ok()?;
            Some(toolbar)
        })();
    }

    fn update_toolbar(&mut self) {
        if let (Some(toolbar), Some(icons)) = (&self.toolbar, PlaybackIcons::new(self.hwnd)) {
            let _ =
                unsafe { toolbar.ThumbBarUpdateButtons(self.hwnd, &icons.buttons(&self.track)) };
        } else if self.toolbar.is_none() {
            self.register_toolbar();
        }
    }

    fn set_custom_thumbnail(&self, enabled: bool) {
        let enabled = i32::from(enabled);
        for attribute in [DWMWA_HAS_ICONIC_BITMAP, DWMWA_FORCE_ICONIC_REPRESENTATION] {
            let _ = unsafe {
                DwmSetWindowAttribute(
                    self.hwnd,
                    attribute,
                    (&raw const enabled).cast(),
                    size_of::<i32>() as u32,
                )
            };
        }
    }

    fn invalidate_thumbnail(&self) {
        let _ = unsafe { DwmInvalidateIconicBitmaps(self.hwnd) };
    }

    fn load_artwork(&mut self) {
        self.artwork = None;
        if let Some(request) = self.artwork_request.take() {
            request.abort();
        }
        self.artwork_revision = self.artwork_revision.wrapping_add(1);
        let revision = self.artwork_revision;
        let Some(url) = self
            .track
            .cover_url
            .clone()
            .filter(|_| self.track.id.is_some())
        else {
            return;
        };
        let app = self.app.clone();
        self.artwork_request = Some(tauri::async_runtime::spawn(async move {
            let Some(artwork) = fetch_artwork(&url).await else {
                return;
            };
            let _ = app.run_on_main_thread(move || {
                PREVIEW.with(|preview| {
                    let Ok(mut preview) = preview.try_borrow_mut() else {
                        return;
                    };
                    if let Some(player) = preview
                        .as_mut()
                        .filter(|player| player.artwork_revision == revision)
                    {
                        player.artwork = Some(artwork);
                        player.invalidate_thumbnail();
                    }
                })
            });
        }));
    }

    fn thumbnail(&self, max_width: u32, max_height: u32) -> Option<Bitmap> {
        let (side, pixels) = thumbnail::render(
            max_width,
            max_height,
            window_dpi(self.hwnd),
            self.artwork.as_ref(),
            self.logo.as_ref(),
            self.track.theme == "dark",
        )?;
        let (bitmap, bits) = Bitmap::new(side, side)?;
        unsafe { &mut *bits }.copy_from_slice(&pixels);
        Some(bitmap)
    }
}

async fn fetch_artwork(raw_url: &str) -> Option<DynamicImage> {
    let url = reqwest::Url::parse(raw_url).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(6))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .ok()?;
    let bilibili_cover = url
        .domain()
        .is_some_and(|host| host.ends_with(".hdslb.com"));
    let mut request = client.get(url);
    if bilibili_cover {
        request = request.header(reqwest::header::REFERER, "https://www.bilibili.com/");
    }
    let mut response = request.send().await.ok()?.error_for_status().ok()?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if bytes.len() + chunk.len() > ARTWORK_LIMIT {
            return None;
        }
        bytes.extend_from_slice(&chunk);
    }
    decode_artwork(&bytes)
}

fn decode_artwork(bytes: &[u8]) -> Option<DynamicImage> {
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    let image = reader.decode().ok()?;
    Some(image.thumbnail(256, 256))
}

struct Bitmap(HBITMAP);

impl Bitmap {
    fn new(width: u32, height: u32) -> Option<(Self, *mut [u8])> {
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width as i32,
                biHeight: -(height as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits = std::ptr::null_mut();
        let bitmap =
            unsafe { CreateDIBSection(None, &info, DIB_RGB_COLORS, &mut bits, None, 0) }.ok()?;
        Some((
            Self(bitmap),
            std::ptr::slice_from_raw_parts_mut(bits.cast(), (width * height * 4) as usize),
        ))
    }
}

impl Drop for Bitmap {
    fn drop(&mut self) {
        let _ = unsafe { DeleteObject(self.0.into()) };
    }
}

struct Icon(HICON);
impl Drop for Icon {
    fn drop(&mut self) {
        let _ = unsafe { DestroyIcon(self.0) };
    }
}

enum Transport {
    Previous,
    Play,
    Pause,
    Next,
}

fn window_dpi(hwnd: HWND) -> u32 {
    unsafe { GetDpiForWindow(hwnd) }.max(96)
}

fn transport_icon(glyph: Transport, width: u32, height: u32) -> Option<Icon> {
    let (bitmap, pixels) = Bitmap::new(width, height)?;
    let pixels = unsafe { &mut *pixels };
    pixels.fill(0);
    for row in 0..height {
        let y = row * 16 / height;
        for column in 0..width {
            let x = column * 16 / width;
            if !(3..13).contains(&y) || !(2..14).contains(&x) {
                continue;
            }
            let triangle =
                |x: u32| (2..=12).contains(&x) && (y as i32 * 2 - 15).unsigned_abs() <= 12 - x;
            let filled = match glyph {
                Transport::Previous => x <= 3 || (x >= 6 && triangle(15 - x)),
                Transport::Play => x >= 4 && triangle(x - 2),
                Transport::Pause => (4..=6).contains(&x) || (9..=11).contains(&x),
                Transport::Next => x >= 12 || (x <= 9 && triangle(x + 3)),
            };
            if filled {
                let offset = ((row * width + column) * 4) as usize;
                pixels[offset..offset + 4].copy_from_slice(&[145, 133, 118, 255]);
            }
        }
    }
    let mask_bytes = vec![0u8; (width.div_ceil(16) * 2 * height) as usize];
    let mask = Bitmap(unsafe {
        CreateBitmap(
            width as i32,
            height as i32,
            1,
            1,
            Some(mask_bytes.as_ptr().cast()),
        )
    });
    if mask.0.is_invalid() {
        return None;
    }
    unsafe {
        CreateIconIndirect(&ICONINFO {
            fIcon: true.into(),
            hbmColor: bitmap.0,
            hbmMask: mask.0,
            ..Default::default()
        })
    }
    .ok()
    .map(Icon)
}

struct PlaybackIcons {
    previous: Icon,
    play: Icon,
    pause: Icon,
    next: Icon,
}

impl PlaybackIcons {
    fn new(hwnd: HWND) -> Option<Self> {
        let dpi = window_dpi(hwnd);
        let width = unsafe { GetSystemMetricsForDpi(SM_CXICON, dpi) }.max(16) as u32;
        let height = unsafe { GetSystemMetricsForDpi(SM_CYICON, dpi) }.max(16) as u32;
        Some(Self {
            previous: transport_icon(Transport::Previous, width, height)?,
            play: transport_icon(Transport::Play, width, height)?,
            pause: transport_icon(Transport::Pause, width, height)?,
            next: transport_icon(Transport::Next, width, height)?,
        })
    }

    fn buttons(&self, track: &Snapshot) -> [THUMBBUTTON; 3] {
        let button = |id, icon: &Icon, label: &str| {
            let mut button = THUMBBUTTON {
                dwMask: THB_ICON | THB_TOOLTIP | THB_FLAGS,
                iId: id,
                hIcon: icon.0,
                dwFlags: if track.id.is_some() {
                    THBF_ENABLED
                } else {
                    THBF_HIDDEN
                },
                ..Default::default()
            };
            for (target, code) in button.szTip.iter_mut().zip(label.encode_utf16()) {
                *target = code;
            }
            button
        };
        let (toggle, label) = if track.playing {
            (&self.pause, "暂停")
        } else {
            (&self.play, "播放")
        };
        [
            button(PREVIOUS, &self.previous, "上一首"),
            button(TOGGLE, toggle, label),
            button(NEXT, &self.next, "下一首"),
        ]
    }
}
