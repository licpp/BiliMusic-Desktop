use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::oneshot;
use uuid::Uuid;

const MAX_BYTES: usize = 512 * 1024;
const MAX_AGE_MS: u64 = 48 * 60 * 60 * 1000;
const FLUSH_INTERVAL: Duration = Duration::from_millis(400);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Area {
    Playback,
    Video,
    Sync,
    Download,
    Startup,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Step {
    Resolve,
    Source,
    MediaReady,
    Start,
    Buffer,
    Decode,
    QualitySwitch,
    Control,
    Recovery,
    TrackRecord,
    AudioFocus,
    MediaKey,
    Export,
    Transfer,
    Convert,
    Destination,
    Exchange,
    Backoff,
    Database,
    MediaProxy,
    NativeReady,
    WebviewReady,
    WebviewProcess,
    ProcessExit,
    PreviousStartup,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Outcome {
    Started,
    Succeeded,
    Failed,
    Skipped,
    Cancelled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Domain {
    Library,
    Statistics,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Source {
    Online,
    LocalDownload,
    Cache,
    LinkedFavorite,
    Collection,
    Playlist,
    Imported,
    Cloud,
    Webdav,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Engine {
    WebAudio,
    WebVideo,
    AndroidMediaPlayer,
    AvPlayer,
    OhosAvplayer,
    Webview2,
    WkWebview,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct Input {
    pub operation: String,
    pub area: Area,
    pub step: Step,
    pub outcome: Outcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initial_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<Source>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<Source>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine: Option<Engine>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub elapsed_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_quality: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual_quality: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codec: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bvid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cid: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain: Option<Domain>,
}

impl Default for Input {
    fn default() -> Self {
        Self {
            operation: String::new(),
            area: Area::Startup,
            step: Step::NativeReady,
            outcome: Outcome::Started,
            code: None,
            initial_code: None,
            source: None,
            origin: None,
            engine: None,
            elapsed_ms: None,
            http: None,
            requested_quality: None,
            actual_quality: None,
            codec: None,
            bvid: None,
            cid: None,
            bytes: None,
            domain: None,
        }
    }
}

impl Input {
    pub fn new(operation: &str, area: Area, step: Step, outcome: Outcome) -> Self {
        Self {
            operation: operation.to_owned(),
            area,
            step,
            outcome,
            ..Default::default()
        }
    }

    fn sanitized(mut self) -> Option<Self> {
        if self.operation.len() != 36
            || Uuid::parse_str(&self.operation).ok()?.get_version_num() != 4
        {
            return None;
        }
        self.code = self.code.filter(|value| safe_code(value));
        self.initial_code = self.initial_code.filter(|value| safe_code(value));
        self.codec = self.codec.filter(|value| {
            let family = value.split('.').next().unwrap_or_default();
            matches!(
                family,
                "mp4a"
                    | "flac"
                    | "fLaC"
                    | "opus"
                    | "ac-3"
                    | "ec-3"
                    | "avc1"
                    | "avc3"
                    | "hev1"
                    | "hvc1"
                    | "av01"
                    | "vp09"
            ) && value.len() <= 32
                && value
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-'))
        });
        self.bvid = self.bvid.filter(|value| {
            value.len() == 12
                && value.starts_with("BV")
                && value.bytes().all(|c| c.is_ascii_alphanumeric())
        });
        self.cid = self
            .cid
            .filter(|value| self.bvid.is_some() && (1..=9_007_199_254_740_991).contains(value));
        self.requested_quality = self.requested_quality.filter(|value| *value <= 40000);
        self.actual_quality = self.actual_quality.filter(|value| *value <= 40000);
        self.http = self.http.filter(|value| (100..=599).contains(value));
        self.elapsed_ms = self.elapsed_ms.filter(|value| *value <= MAX_AGE_MS);
        Some(self)
    }
}

fn safe_code(value: &str) -> bool {
    if value.len() > 64 {
        return false;
    }
    if matches!(
        value,
        "account_changed"
            | "profile_unavailable"
            | "native_not_ready"
            | "native_request_failed"
            | "native_observation_failed"
            | "native_loudness_unavailable"
            | "source_timeout"
            | "source_unavailable"
            | "source_expired"
            | "invalid_source"
            | "offline_unavailable"
            | "audio_stalled"
            | "video_stalled"
            | "audio_focus_denied"
            | "audio_prepare_failed"
            | "audio_resume_failed"
            | "duration_unavailable"
            | "autoplay_blocked"
            | "provider_error"
            | "database_error"
            | "invalid_input"
            | "track_missing"
            | "cid_mismatch"
            | "proxy_unavailable"
            | "compatible_audio"
            | "progressive_audio"
            | "partial"
            | "conflict"
            | "rate_limited"
            | "connection"
            | "account"
            | "limit"
            | "data"
            | "retry"
            | "permission_denied"
            | "storage_full"
            | "invalid_length"
            | "write_failed"
            | "convert_failed"
            | "export_failed"
            | "transfer_failed"
            | "render_error"
            | "script_error"
            | "promise_rejection"
            | "startup_incomplete"
            | "exit_unknown"
            | "panic"
            | "metered"
            | "resume"
            | "pause"
            | "resume_ui"
            | "resume_delivered"
            | "notification_resume"
            | "notification_pause"
            | "next"
            | "previous"
            | "duck"
            | "gain"
            | "loss"
            | "transient_loss"
            | "focus_delayed"
            | "action_denied"
    ) {
        return true;
    }
    let parts: Vec<_> = value.split(':').take(4).collect();
    let number = |part: &str| part.len() <= 16 && part.parse::<i64>().is_ok();
    match parts.as_slice() {
        ["android_media", what, extra] => number(what) && number(extra),
        ["ios_media", domain, code] => {
            matches!(
                *domain,
                "NSURLErrorDomain"
                    | "NSOSStatusErrorDomain"
                    | "NSPOSIXErrorDomain"
                    | "AVFoundationErrorDomain"
                    | "CoreMediaErrorDomain"
                    | "other"
            ) && number(code)
        }
        [
            "ohos_media" | "html_media" | "http" | "bili_api" | "android_exit" | "webview_process"
            | "ios_crash",
            code,
        ] => number(code),
        _ => false,
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub at: u64,
    pub build: String,
    pub event: Input,
}

#[derive(Clone, Serialize, Deserialize)]
struct Stored {
    // Used for local filtering only. Reports are built from Record.
    profile: Option<String>,
    record: Record,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct StartupMarker {
    operation: String,
    step: Step,
    at: u64,
}

fn version() -> String {
    concat!(
        env!("CARGO_PKG_VERSION"),
        ".",
        env!("BILIMUSIC_BUILD_NUMBER")
    )
    .into()
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Clone)]
pub struct Diagnostics {
    sender: SyncSender<Message>,
    startup: String,
    ready: std::sync::Arc<std::sync::atomic::AtomicBool>,
    directory: PathBuf,
}

enum Message {
    Record(Stored),
    Flush(mpsc::SyncSender<()>),
    Snapshot {
        profile: String,
        operation: Option<String>,
        area: Option<Area>,
        reply: oneshot::Sender<Vec<Record>>,
    },
    Clear {
        profile: String,
        reply: oneshot::Sender<bool>,
    },
}

impl Diagnostics {
    pub fn open(directory: PathBuf) -> Self {
        let (sender, receiver) = mpsc::sync_channel(192);
        let startup = Uuid::new_v4().to_string();
        let worker_directory = directory.clone();
        let _ = std::thread::Builder::new()
            .name("diagnostics".into())
            .spawn(move || run(&worker_directory, receiver, flush));
        Self {
            sender,
            startup,
            directory,
            ready: Default::default(),
        }
    }

    pub fn begin_startup(&self) {
        if let Some(marker) =
            read_limited::<StartupMarker>(&self.directory.join("startup.json"), 1024)
        {
            let at = now_ms();
            if marker.at <= at && at - marker.at < MAX_AGE_MS {
                self.record(
                    None,
                    Input {
                        code: Some("startup_incomplete".into()),
                        ..Input::new(
                            &marker.operation,
                            Area::Startup,
                            marker.step,
                            Outcome::Failed,
                        )
                    },
                );
            }
        }
        self.startup_step(Step::Database, Outcome::Started);
    }

    pub fn webview_ready(&self) -> bool {
        use std::sync::atomic::Ordering;
        if self.ready.swap(true, Ordering::Relaxed) {
            return false;
        }
        self.startup_step(Step::WebviewReady, Outcome::Succeeded);
        true
    }

    pub fn device_failure(&self, step: Step, engine: Option<Engine>, code: String, at: u64) {
        let now = now_ms();
        if at > now || now - at >= MAX_AGE_MS {
            return;
        }
        let input = Input {
            code: Some(code),
            engine,
            ..Input::new(&self.startup, Area::Startup, step, Outcome::Failed)
        };
        if let Some(event) = input.sanitized() {
            let _ = self.sender.try_send(Message::Record(Stored {
                profile: None,
                record: Record {
                    at,
                    build: version(),
                    event,
                },
            }));
        }
    }

    pub fn startup_step(&self, step: Step, outcome: Outcome) {
        self.record(
            None,
            Input::new(&self.startup, Area::Startup, step, outcome),
        );
        let marker = self.directory.join("startup.json");
        if step == Step::WebviewReady && outcome == Outcome::Succeeded {
            let _ = fs::remove_file(marker);
        } else if outcome == Outcome::Started {
            let _ = write_atomic(
                &marker,
                &StartupMarker {
                    operation: self.startup.clone(),
                    step,
                    at: now_ms(),
                },
            );
        }
    }

    pub fn record(&self, profile: Option<String>, input: Input) {
        if let Some(event) = input.sanitized() {
            let _ = self.sender.try_send(Message::Record(Stored {
                profile,
                record: Record {
                    at: now_ms(),
                    build: version(),
                    event,
                },
            }));
        }
    }

    pub fn flush_on_exit(&self) {
        let (reply, flushed) = mpsc::sync_channel(1);
        if self.sender.try_send(Message::Flush(reply)).is_ok() {
            let _ = flushed.recv_timeout(Duration::from_millis(150));
        }
    }

    pub async fn snapshot_filtered(
        &self,
        profile: String,
        operation: Option<String>,
        area: Option<Area>,
    ) -> Result<Vec<Record>, &'static str> {
        let (reply, receiver) = oneshot::channel();
        self.sender
            .try_send(Message::Snapshot {
                profile,
                operation,
                area,
                reply,
            })
            .map_err(|_| "诊断记录暂不可用")?;
        receiver.await.map_err(|_| "诊断记录暂不可用")
    }

    pub async fn clear(&self, profile: String) -> Result<bool, &'static str> {
        let (reply, receiver) = oneshot::channel();
        self.sender
            .try_send(Message::Clear { profile, reply })
            .map_err(|_| "诊断记录暂不可用")?;
        receiver.await.map_err(|_| "诊断记录暂不可用")
    }
}

fn read_limited<T: serde::de::DeserializeOwned>(path: &Path, limit: usize) -> Option<T> {
    let mut bytes = Vec::new();
    fs::File::open(path)
        .ok()?
        .take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() > limit {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

fn write_atomic(path: &Path, value: &impl Serialize) -> std::io::Result<()> {
    use std::io::Write;
    let directory = path.parent().ok_or(std::io::ErrorKind::InvalidInput)?;
    fs::create_dir_all(directory)?;
    let temp = path.with_extension("tmp");
    let mut options = fs::OpenOptions::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .create(true)
        .write(true)
        .truncate(true)
        .open(&temp)?;
    serde_json::to_writer(&mut file, value)?;
    file.flush()?;
    drop(file);
    fs::rename(temp, path)
}

fn trim(records: &mut VecDeque<(usize, Stored)>, bytes: &mut usize, now: u64) {
    records.retain(|(size, item)| {
        let retain = item.record.at <= now && now - item.record.at < MAX_AGE_MS;
        if !retain {
            *bytes -= size;
        }
        retain
    });
    while *bytes > MAX_BYTES - 2 {
        if let Some((size, _)) = records.pop_front() {
            *bytes -= size;
        }
    }
}

fn serialized_size(item: &Stored) -> usize {
    serde_json::to_vec(item).map_or(MAX_BYTES, |bytes| bytes.len() + 1)
}
fn flush(path: &Path, records: &VecDeque<(usize, Stored)>) -> bool {
    write_atomic(
        path,
        &records.iter().map(|(_, item)| item).collect::<Vec<_>>(),
    )
    .is_ok()
}
fn run(
    directory: &Path,
    receiver: Receiver<Message>,
    flush: impl Fn(&Path, &VecDeque<(usize, Stored)>) -> bool,
) {
    let path = directory.join("events.json");
    let mut records: VecDeque<_> = read_limited::<Vec<Stored>>(&path, MAX_BYTES)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|mut item| {
            item.record.event = item.record.event.sanitized()?;
            Some((serialized_size(&item), item))
        })
        .collect();
    let mut bytes = records.iter().map(|(size, _)| *size).sum();
    let mut dirty = !records.is_empty();
    let mut last_flush = Instant::now();
    loop {
        let wait = if dirty {
            FLUSH_INTERVAL.saturating_sub(last_flush.elapsed())
        } else {
            Duration::from_secs(60)
        };
        match receiver.recv_timeout(wait) {
            Ok(Message::Record(item)) => {
                let same_native_report = item.record.event.step == Step::ProcessExit
                    && records.iter().any(|(_, saved)| {
                        saved.record.at == item.record.at
                            && saved.record.event.step == Step::ProcessExit
                            && saved.record.event.code == item.record.event.code
                    });
                if same_native_report {
                    continue;
                }
                let size = serialized_size(&item);
                bytes += size;
                records.push_back((size, item));
                dirty = true;
            }
            Ok(Message::Flush(reply)) => {
                if dirty && flush(&path, &records) {
                    dirty = false;
                }
                let _ = reply.send(());
            }
            Ok(Message::Snapshot {
                profile,
                operation,
                area,
                reply,
            }) => {
                trim(&mut records, &mut bytes, now_ms());
                let mut selected: Vec<_> = records
                    .iter()
                    .rev()
                    .filter(|(_, item)| {
                        item.profile.as_ref().is_none_or(|owner| owner == &profile)
                            && operation
                                .as_ref()
                                .is_none_or(|id| id == &item.record.event.operation)
                            && area.is_none_or(|area| area == item.record.event.area)
                    })
                    .map(|(_, item)| &item.record)
                    .collect();
                selected.sort_by_key(|record| std::cmp::Reverse(record.at));
                let result = selected
                    .into_iter()
                    .take(if operation.is_some() { 96 } else { 200 })
                    .cloned()
                    .collect();
                let _ = reply.send(result);
            }
            Ok(Message::Clear { profile, reply }) => {
                let remaining = records
                    .iter()
                    .filter(|(_, item)| {
                        item.profile.as_ref().is_some_and(|owner| owner != &profile)
                    })
                    .cloned()
                    .collect::<VecDeque<_>>();
                let cleared = flush(&path, &remaining);
                if cleared {
                    records = remaining;
                    bytes = records.iter().map(|(size, _)| *size).sum();
                    dirty = false;
                }
                let _ = reply.send(cleared);
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                if dirty {
                    let _ = flush(&path, &records);
                }
                return;
            }
        }
        let before = bytes;
        trim(&mut records, &mut bytes, now_ms());
        dirty |= before != bytes;
        if dirty && last_flush.elapsed() >= FLUSH_INTERVAL {
            dirty = !flush(&path, &records);
            last_flush = Instant::now();
        }
    }
}

/// Captures the owner and operation before asynchronous work begins.
pub struct Trace {
    journal: Option<Diagnostics>,
    profile: String,
    started: Instant,
    pub event: Input,
}

impl Trace {
    pub fn for_profile(app: &tauri::AppHandle, profile: String, area: Area) -> Self {
        use tauri::Manager;
        Self::with_journal(
            app.try_state::<Diagnostics>()
                .map(|state| state.inner().clone()),
            profile,
            area,
        )
    }

    pub fn with_journal(journal: Option<Diagnostics>, profile: String, area: Area) -> Self {
        Self {
            journal,
            profile,
            started: Instant::now(),
            event: Input::new(
                &Uuid::new_v4().to_string(),
                area,
                Step::Resolve,
                Outcome::Started,
            ),
        }
    }

    pub fn emit(&self, step: Step, outcome: Outcome, code: Option<&str>) {
        if let Some(journal) = &self.journal {
            let mut event = self.event.clone();
            event.step = step;
            event.outcome = outcome;
            event.elapsed_ms = Some(self.started.elapsed().as_millis() as u64);
            event.code = code.map(str::to_owned);
            journal.record(Some(self.profile.clone()), event);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            Self(
                std::env::temp_dir().join(format!("bilimusic-diagnostics-test-{}", Uuid::new_v4())),
            )
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn operation() -> String {
        Uuid::new_v4().to_string()
    }
    fn event(id: &str, area: Area, step: Step) -> Input {
        Input::new(id, area, step, Outcome::Failed)
    }

    #[test]
    fn timed_flush_retries_after_the_destination_becomes_writable() {
        let directory = Temp::new();
        let path = directory.0.join("events.json");
        fs::create_dir_all(&path).unwrap();
        let (sender, receiver) = mpsc::sync_channel(1);
        let (report, writes) = mpsc::channel();
        let worker_directory = directory.0.clone();
        let worker = std::thread::spawn(move || {
            run(&worker_directory, receiver, |path, records| {
                let written = flush(path, records);
                let _ = report.send(written);
                written
            });
        });
        let id = operation();
        sender
            .send(Message::Record(Stored {
                profile: None,
                record: Record {
                    at: now_ms(),
                    build: version(),
                    event: event(&id, Area::Playback, Step::Source),
                },
            }))
            .unwrap();
        assert!(!writes.recv_timeout(Duration::from_secs(3)).unwrap());
        fs::remove_dir(&path).unwrap();
        assert!(writes.recv_timeout(Duration::from_secs(3)).unwrap());
        let records = read_limited::<Vec<Stored>>(&path, MAX_BYTES).unwrap();
        assert_eq!(records[0].record.event.operation, id);
        drop(sender);
        worker.join().unwrap();
    }

    #[test]
    fn only_allowlisted_diagnostic_fields_reach_the_journal() {
        let mut event = event(&operation(), Area::Playback, Step::Source);
        event.code = Some("Bearer abc https://test.invalid/?sign=secret".into());
        event.initial_code = Some("android_media:100:1".into());
        event.bvid = Some("/Users/test/my_private_file".into());
        event.cid = Some(456);
        event.codec = Some("https://private.test/local".into());
        event.http = Some(900);
        event.requested_quality = Some(30280);
        let sanitized = event.sanitized().unwrap();
        assert_eq!(
            sanitized.initial_code.as_deref(),
            Some("android_media:100:1")
        );
        assert_eq!(sanitized.requested_quality, Some(30280));
        assert!(sanitized.bvid.is_none() && sanitized.cid.is_none());
        assert!(sanitized.codec.is_none() && sanitized.http.is_none() && sanitized.code.is_none());
        for code in ["native_observation_failed", "native_loudness_unavailable"] {
            let mut failure =
                Input::new(&operation(), Area::Playback, Step::Control, Outcome::Failed);
            failure.code = Some(code.into());
            assert_eq!(failure.sanitized().unwrap().code.as_deref(), Some(code));
        }
        let mut focus = Input::new(
            &operation(),
            Area::Playback,
            Step::AudioFocus,
            Outcome::Started,
        );
        focus.code = Some("focus_delayed".into());
        assert_eq!(
            focus.sanitized().unwrap().code.as_deref(),
            Some("focus_delayed")
        );
        assert!(
            serde_json::from_value::<Input>(serde_json::json!({
                "operation":operation(), "area":"playback", "step":"source", "outcome":"failed",
                "url":"http://token@secret.test"
            }))
            .is_err()
        );
        assert!(
            Input::new(
                "name@user.test",
                Area::Startup,
                Step::Database,
                Outcome::Failed
            )
            .sanitized()
            .is_none()
        );
    }

    #[tokio::test]
    async fn reports_filter_by_account_area_and_operation_and_clear_independently() {
        let directory = Temp::new();
        let diagnostic = Diagnostics::open(directory.0.clone());
        let id = operation();
        let other_id = operation();
        diagnostic.record(
            Some("account-a".into()),
            event(&id, Area::Playback, Step::Source),
        );
        diagnostic.record(
            Some("account-a".into()),
            event(&other_id, Area::Download, Step::Transfer),
        );
        diagnostic.record(
            Some("account-b".into()),
            event(&other_id, Area::Playback, Step::Source),
        );
        diagnostic.record(None, event(&operation(), Area::Startup, Step::Database));

        let all = diagnostic
            .snapshot_filtered("account-a".into(), None, None)
            .await
            .unwrap();
        assert_eq!(all.len(), 3);
        let recent = diagnostic
            .snapshot_filtered("account-a".into(), Some(id), Some(Area::Playback))
            .await
            .unwrap();
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].event.area, Area::Playback);
        let report = serde_json::to_string(&all).unwrap();
        assert!(!report.contains("account-a") && !report.contains("account-b"));
        assert!(diagnostic.clear("account-a".into()).await.unwrap());
        assert!(
            diagnostic
                .snapshot_filtered("account-a".into(), None, None)
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            diagnostic
                .snapshot_filtered("account-b".into(), None, None)
                .await
                .unwrap()
                .len(),
            1
        );
        let restored =
            read_limited::<Vec<Stored>>(&directory.0.join("events.json"), MAX_BYTES).unwrap();
        assert_eq!(restored[0].profile.as_deref(), Some("account-b"));
    }

    #[test]
    fn old_or_oversized_history_rolls_over() {
        let now = now_ms();
        let mut records = VecDeque::new();
        for at in [now - MAX_AGE_MS, now - 1000, now, now + 1000] {
            records.push_back((
                MAX_BYTES / 2,
                Stored {
                    profile: None,
                    record: Record {
                        at,
                        build: version(),
                        event: event(&operation(), Area::Playback, Step::Start),
                    },
                },
            ));
        }
        let mut bytes = MAX_BYTES * 2;
        trim(&mut records, &mut bytes, now);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].1.record.at, now);
        assert_eq!(bytes, MAX_BYTES / 2);
    }

    #[tokio::test]
    async fn an_incomplete_boot_is_distinct_from_confirmed_system_exit_and_ready_is_idempotent() {
        let directory = Temp::new();
        let previous = operation();
        write_atomic(
            &directory.0.join("startup.json"),
            &StartupMarker {
                operation: previous.clone(),
                step: Step::MediaProxy,
                at: now_ms(),
            },
        )
        .unwrap();
        let diagnostic = Diagnostics::open(directory.0.clone());
        diagnostic.begin_startup();
        let at = now_ms() - 1000;
        for _ in 0..2 {
            diagnostic.device_failure(Step::ProcessExit, None, "android_exit:6".into(), at);
        }
        assert!(diagnostic.webview_ready());
        assert!(!diagnostic.webview_ready());
        assert!(!directory.0.join("startup.json").exists());
        let recent = diagnostic
            .snapshot_filtered("".into(), None, Some(Area::Startup))
            .await
            .unwrap();
        assert_eq!(
            recent
                .iter()
                .filter(|r| r.event.step == Step::ProcessExit)
                .count(),
            1
        );
        let previous = recent
            .iter()
            .find(|r| r.event.operation == previous)
            .unwrap();
        assert_eq!(previous.event.step, Step::MediaProxy);
        assert_eq!(previous.event.code.as_deref(), Some("startup_incomplete"));
    }

    #[tokio::test]
    async fn report_survives_reopen_and_groups_first_failure_with_final_result() {
        let directory = Temp::new();
        let diagnostic = Diagnostics::open(directory.0.clone());
        let id = operation();
        let mut failed = event(&id, Area::Playback, Step::Source);
        failed.initial_code = Some("android_media:100:1".into());
        failed.code = Some("track_missing".into());
        diagnostic.record(Some("guest".into()), failed);
        let newest = diagnostic
            .snapshot_filtered("guest".into(), None, None)
            .await
            .unwrap();
        assert_eq!(
            newest[0].event.initial_code.as_deref(),
            Some("android_media:100:1")
        );
        diagnostic.flush_on_exit();
        drop(diagnostic);
        let reopened = Diagnostics::open(directory.0.clone());
        let restored = reopened
            .snapshot_filtered("guest".into(), Some(id), None)
            .await
            .unwrap();
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].event.code.as_deref(), Some("track_missing"));
    }
}
