//! Profile-local batch matching checkpoints. One ordered selection is kept per
//! linked folder, and only the current video needs to be expanded at a time.
use super::{account, batch_matching, commands, error::CommandError};
use crate::{
    infrastructure::{
        database::Database,
        diagnostics::now_ms,
        repositories::{
            library::{MetadataPatch, TrackInput},
            lyrics::SaveLyricsInput,
        },
    },
    sync::visibility,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use tauri::State;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum JobState {
    Running,
    Paused,
    Completed,
    Cancelled,
}

impl JobState {
    fn pending(self) -> bool {
        matches!(self, Self::Running | Self::Paused)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PauseReason {
    RateLimited,
    VerificationRequired,
    AuthRequired,
    Network,
    User,
    Other,
}

#[derive(Default, Deserialize, Serialize)]
struct Counts {
    matched: usize,
    skipped: usize,
    failed: usize,
    protected: usize,
    unmatched: usize,
    conflicts: usize,
}

impl Counts {
    fn track(&mut self, outcome: TrackOutcome) {
        match outcome {
            TrackOutcome::Failed => self.failed += 1,
            TrackOutcome::Skipped => self.skipped += 1,
            TrackOutcome::Protected => {
                self.skipped += 1;
                self.protected += 1;
            }
            TrackOutcome::Unmatched => {
                self.skipped += 1;
                self.unmatched += 1;
            }
            TrackOutcome::Conflict => {
                self.skipped += 1;
                self.conflicts += 1;
            }
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    run_id: String,
    state: JobState,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<PauseReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    retry_at: Option<u64>,
    done: usize,
    total: usize,
    #[serde(flatten)]
    counts: Counts,
}

#[derive(Deserialize, Serialize)]
struct StoredJob {
    // An account session belongs to one open native database connection. A
    // resumed job is rebound explicitly, even if the profile is the same.
    session: String,
    progress: Progress,
}

#[derive(Serialize)]
struct PendingVideo {
    bvid: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    tracks: Option<Vec<TrackInput>>,
    #[serde(skip)]
    part_order: Option<usize>,
}

#[derive(Serialize)]
pub struct LinkedMatchJob {
    #[serde(flatten)]
    progress: Progress,
    #[serde(skip_serializing_if = "Option::is_none")]
    next: Option<PendingVideo>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VideoOutcome {
    Skipped,
    Failed,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TrackOutcome {
    Protected,
    Unmatched,
    Conflict,
    Skipped,
    Failed,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum JobUpdate {
    Resolve {
        bvid: String,
        tracks: Vec<TrackInput>,
    },
    SkipVideo {
        bvid: String,
        outcome: VideoOutcome,
    },
    FinishTrack {
        bvid: String,
        track_id: String,
        outcome: TrackOutcome,
    },
    Pause {
        reason: PauseReason,
        retry_at: Option<u64>,
    },
    Cancel,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchLease {
    pub(super) folder_id: i64,
    pub(super) run_id: String,
    pub(super) bvid: String,
}

fn changed() -> CommandError {
    CommandError::validation("批量匹配的进度已更新，请重新读取")
}

fn load(c: &Connection, folder_id: i64) -> Result<Option<StoredJob>, CommandError> {
    let raw: Option<String> = c
        .query_row(
            "SELECT state_json FROM linked_batch_match_jobs WHERE folder_id=?1",
            [folder_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(CommandError::database)?;
    raw.map(|json| serde_json::from_str(&json).map_err(CommandError::database))
        .transpose()
}

fn save(c: &Connection, folder_id: i64, job: &StoredJob) -> Result<(), CommandError> {
    let json = serde_json::to_string(job).map_err(CommandError::database)?;
    c.execute(
        "INSERT INTO linked_batch_match_jobs VALUES(?1,?2) ON CONFLICT(folder_id) DO UPDATE SET state_json=excluded.state_json",
        params![folder_id, json],
    ).map_err(CommandError::database)?;
    Ok(())
}

fn head(c: &Connection, folder_id: i64, progress: &Progress) -> Result<PendingVideo, CommandError> {
    let (bvid, resolved, raw, part_order): (String, bool, Option<String>, Option<usize>) = c
        .query_row(
            "SELECT v.bvid,v.resolved,p.track_json,p.part_order FROM linked_batch_match_videos v
         LEFT JOIN linked_batch_match_parts p ON p.folder_id=v.folder_id AND p.position=v.position
         WHERE v.folder_id=?1 AND v.position=?2 ORDER BY p.part_order LIMIT 1",
            params![folder_id, progress.done],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(CommandError::database)?;
    let track = raw
        .map(|raw| serde_json::from_str(&raw))
        .transpose()
        .map_err(CommandError::database)?;
    let tracks = resolved.then(|| track.into_iter().collect());
    Ok(PendingVideo {
        bvid,
        tracks,
        part_order,
    })
}

fn view(
    c: &Connection,
    folder_id: i64,
    session: &str,
    job: StoredJob,
) -> Result<LinkedMatchJob, CommandError> {
    let mut progress = job.progress;
    // A process restart or account switch leaves the checkpoint ready for an
    // explicit resume, with no active lease from the previous connection.
    if progress.state == JobState::Running && job.session != session {
        progress.state = JobState::Paused;
        progress.reason = Some(PauseReason::Other);
    }
    let next = progress
        .state
        .pending()
        .then(|| head(c, folder_id, &progress))
        .transpose()?;
    Ok(LinkedMatchJob { progress, next })
}

fn resolve(
    c: &Connection,
    folder_id: i64,
    position: usize,
    tracks: &[TrackInput],
) -> Result<usize, CommandError> {
    let mut skipped = 0;
    for (part_order, track) in tracks.iter().enumerate() {
        if !eligible_track(c, track)? {
            skipped += 1;
            continue;
        }
        let raw = serde_json::to_string(track).map_err(CommandError::database)?;
        c.execute(
            "INSERT INTO linked_batch_match_parts VALUES(?1,?2,?3,?4)",
            params![folder_id, position, part_order, raw],
        )
        .map_err(CommandError::database)?;
    }
    c.execute(
        "UPDATE linked_batch_match_videos SET resolved=1 WHERE folder_id=?1 AND position=?2",
        params![folder_id, position],
    )
    .map_err(CommandError::database)?;
    Ok(skipped)
}

fn advance(c: &Connection, folder_id: i64, progress: &mut Progress) -> Result<(), CommandError> {
    c.execute(
        "DELETE FROM linked_batch_match_videos WHERE folder_id=?1 AND position=?2",
        params![folder_id, progress.done],
    )
    .map_err(CommandError::database)?;
    progress.done += 1;
    if progress.done == progress.total {
        progress.state = JobState::Completed;
    }
    Ok(())
}

fn eligible_video(c: &Connection, folder_id: i64, bvid: &str) -> Result<bool, CommandError> {
    c.prepare_cached(
        "SELECT EXISTS(SELECT 1 FROM linked_bili_folders AS folder, json_each(folder.videos_json) AS video
           WHERE folder.folder_id=?1 AND json_extract(video.value,'$.bvid')=?2
             AND (COALESCE(json_extract(video.value,'$.attr'),0) & 8)=0
             AND trim(COALESCE(json_extract(video.value,'$.title'),''))<>'已失效视频')",
    ).and_then(|mut query| query.query_row(params![folder_id, bvid], |row| row.get(0)))
        .map_err(CommandError::database)
}

fn eligible_track(c: &Connection, track: &TrackInput) -> Result<bool, CommandError> {
    visibility::allowed(c, &track.bvid, track.cid, None).map_err(CommandError::database)
}

// Recheck the latest complete folder snapshot and the current visibility rules
// before handing out work. A second check before commit protects in-flight work.
fn prune(c: &Connection, folder_id: i64, progress: &mut Progress) -> Result<(), CommandError> {
    while progress.state == JobState::Running {
        let video = head(c, folder_id, progress)?;
        if !eligible_video(c, folder_id, &video.bvid)? {
            let count: usize = c.query_row(
                "SELECT COUNT(*) FROM linked_batch_match_parts WHERE folder_id=?1 AND position=?2",
                params![folder_id, progress.done],
                |row| row.get(0),
            ).map_err(CommandError::database)?;
            progress.counts.skipped += if video.tracks.is_some() { count } else { 1 };
            advance(c, folder_id, progress)?;
            continue;
        }
        let Some(tracks) = video.tracks.as_ref() else {
            break;
        };
        match tracks.first() {
            None => advance(c, folder_id, progress)?,
            Some(track) if !eligible_track(c, track)? => {
                progress.counts.track(TrackOutcome::Skipped);
                finish_track(c, folder_id, progress, &video)?;
            }
            Some(_) => break,
        }
    }
    Ok(())
}

fn checked_tracks(
    tracks: Vec<TrackInput>,
) -> Result<HashMap<String, Vec<TrackInput>>, CommandError> {
    let mut grouped: HashMap<String, Vec<TrackInput>> = HashMap::new();
    let mut seen = HashSet::new();
    for track in tracks {
        commands::validate_track(&track)?;
        if seen.insert(track.id.clone()) {
            grouped.entry(track.bvid.clone()).or_default().push(track);
        }
    }
    Ok(grouped)
}

fn start(
    c: &Connection,
    folder_id: i64,
    session: &str,
    bvids: Option<Vec<String>>,
    tracks: Option<Vec<TrackInput>>,
) -> Result<LinkedMatchJob, CommandError> {
    let tx = c.unchecked_transaction().map_err(CommandError::database)?;
    account::check_account_session(&tx, session)?;
    let existing = load(&tx, folder_id)?;
    let mut job = if let Some(mut bvids) = bvids {
        if existing.is_some_and(|job| job.progress.state.pending()) {
            return Err(CommandError::validation("请先继续或取消当前匹配任务"));
        }
        let mut seen = HashSet::new();
        bvids.retain(|bvid| seen.insert(bvid.clone()));
        if bvids.is_empty() || bvids.iter().any(|bvid| !commands::valid_bvid(bvid)) {
            return Err(CommandError::validation("没有可匹配的视频"));
        }
        let mut grouped = checked_tracks(tracks.unwrap_or_default())?;
        if grouped.keys().any(|bvid| !seen.contains(bvid)) {
            return Err(CommandError::validation("分 P 不在选中的视频中"));
        }
        let linked: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM linked_bili_folders WHERE folder_id=?1)",
                [folder_id],
                |row| row.get(0),
            )
            .map_err(CommandError::database)?;
        if !linked {
            return Err(CommandError::validation("收藏夹已解除关联"));
        }
        let mut task = StoredJob {
            session: session.to_owned(),
            progress: Progress {
                run_id: uuid::Uuid::new_v4().to_string(),
                state: JobState::Running,
                reason: None,
                retry_at: None,
                done: 0,
                total: bvids.len(),
                counts: Counts::default(),
            },
        };
        save(&tx, folder_id, &task)?;
        for (position, bvid) in bvids.into_iter().enumerate() {
            tx.execute(
                "INSERT INTO linked_batch_match_videos(folder_id,position,bvid) VALUES(?1,?2,?3)",
                params![folder_id, position, bvid],
            )
            .map_err(CommandError::database)?;
            if let Some(tracks) = grouped.remove(&bvid) {
                task.progress.counts.skipped += resolve(&tx, folder_id, position, &tracks)?;
            }
        }
        task
    } else {
        let mut task = existing
            .filter(|job| job.progress.state.pending())
            .ok_or_else(changed)?;
        if task
            .progress
            .retry_at
            .is_some_and(|retry_at| retry_at > now_ms())
        {
            return view(&tx, folder_id, session, task);
        }
        task.progress.run_id = uuid::Uuid::new_v4().to_string();
        task.progress.state = JobState::Running;
        task.progress.reason = None;
        task.progress.retry_at = None;
        task.session = session.to_owned();
        task
    };
    prune(&tx, folder_id, &mut job.progress)?;
    save(&tx, folder_id, &job)?;
    let result = view(&tx, folder_id, session, job)?;
    tx.commit().map_err(CommandError::database)?;
    Ok(result)
}

fn next_track<'a>(
    video: &'a PendingVideo,
    bvid: &str,
    track_id: &str,
) -> Result<&'a TrackInput, CommandError> {
    video
        .tracks
        .as_ref()
        .and_then(|tracks| tracks.first())
        .filter(|track| video.bvid == bvid && track.id == track_id)
        .ok_or_else(changed)
}

fn finish_track(
    c: &Connection,
    folder_id: i64,
    progress: &Progress,
    video: &PendingVideo,
) -> Result<(), CommandError> {
    c.execute(
        "DELETE FROM linked_batch_match_parts WHERE folder_id=?1 AND position=?2 AND part_order=?3",
        params![
            folder_id,
            progress.done,
            video.part_order.ok_or_else(changed)?
        ],
    )
    .map_err(CommandError::database)?;
    Ok(())
}

fn update(
    c: &Connection,
    folder_id: i64,
    session: &str,
    run_id: &str,
    operation: JobUpdate,
) -> Result<LinkedMatchJob, CommandError> {
    let tx = c.unchecked_transaction().map_err(CommandError::database)?;
    account::check_account_session(&tx, session)?;
    let mut job = load(&tx, folder_id)?
        .filter(|job| job.progress.run_id == run_id)
        .ok_or_else(changed)?;
    if matches!(operation, JobUpdate::Cancel) {
        if !job.progress.state.pending() {
            return view(&tx, folder_id, session, job);
        }
        job.progress.state = JobState::Cancelled;
        job.progress.reason = None;
        job.progress.retry_at = None;
        tx.execute(
            "DELETE FROM linked_batch_match_videos WHERE folder_id=?1",
            [folder_id],
        )
        .map_err(CommandError::database)?;
    } else {
        if job.session != session {
            return Err(changed());
        }
        if job.progress.state != JobState::Running {
            // A user pause may race the final successful commit. Return the
            // committed state to the caller even though no work remains to pause.
            if matches!(operation, JobUpdate::Pause { .. }) {
                return view(&tx, folder_id, session, job);
            }
            return Err(changed());
        }
        apply_update(&tx, folder_id, &mut job.progress, operation)?;
        prune(&tx, folder_id, &mut job.progress)?;
    }
    save(&tx, folder_id, &job)?;
    let result = view(&tx, folder_id, session, job)?;
    tx.commit().map_err(CommandError::database)?;
    Ok(result)
}

fn apply_update(
    c: &Connection,
    folder_id: i64,
    progress: &mut Progress,
    operation: JobUpdate,
) -> Result<(), CommandError> {
    match operation {
        JobUpdate::Resolve { bvid, tracks } => {
            let next = head(c, folder_id, progress)?;
            if next.bvid != bvid || next.tracks.is_some() {
                return Err(changed());
            }
            let mut grouped = checked_tracks(tracks)?;
            let tracks = grouped.remove(&bvid).unwrap_or_default();
            if !grouped.is_empty() {
                return Err(CommandError::validation("歌曲来源标识不一致"));
            }
            progress.counts.skipped += resolve(c, folder_id, progress.done, &tracks)?;
        }
        JobUpdate::SkipVideo { bvid, outcome } => {
            let next = head(c, folder_id, progress)?;
            if next.bvid != bvid || next.tracks.is_some() {
                return Err(changed());
            }
            match outcome {
                VideoOutcome::Failed if eligible_video(c, folder_id, &bvid)? => {
                    progress.counts.failed += 1;
                }
                _ => progress.counts.skipped += 1,
            }
            advance(c, folder_id, progress)?;
        }
        JobUpdate::FinishTrack {
            bvid,
            track_id,
            outcome,
        } => {
            let video = head(c, folder_id, progress)?;
            let track = next_track(&video, &bvid, &track_id)?;
            let outcome = if eligible_video(c, folder_id, &bvid)? && eligible_track(c, track)? {
                outcome
            } else {
                TrackOutcome::Skipped
            };
            progress.counts.track(outcome);
            finish_track(c, folder_id, progress, &video)?;
        }
        JobUpdate::Pause { reason, retry_at } => {
            progress.state = JobState::Paused;
            progress.reason = Some(reason);
            progress.retry_at = retry_at;
        }
        JobUpdate::Cancel => unreachable!("cancellation is handled before checking the run lease"),
    }
    Ok(())
}

pub(super) fn commit(
    c: &Connection,
    lease: &MatchLease,
    session: &str,
    track_id: &str,
    expected_lyric_token: Option<&str>,
    metadata: &MetadataPatch,
    lyrics: &SaveLyricsInput,
) -> Result<bool, CommandError> {
    let tx = c.unchecked_transaction().map_err(CommandError::database)?;
    account::check_account_session(&tx, session)?;
    let mut job = load(&tx, lease.folder_id)?
        .filter(|job| {
            job.session == session
                && job.progress.run_id == lease.run_id
                && job.progress.state == JobState::Running
        })
        .ok_or_else(changed)?;
    let video = head(&tx, lease.folder_id, &job.progress)?;
    let track = next_track(&video, &lease.bvid, track_id)?;
    let mut saved = false;
    if eligible_video(&tx, lease.folder_id, &lease.bvid)? && eligible_track(&tx, track)? {
        batch_matching::validate(metadata, lyrics)?;
        saved = batch_matching::apply_pair(
            &tx,
            track_id,
            expected_lyric_token,
            metadata,
            lyrics,
            Some(track),
        )?;
        if saved {
            job.progress.counts.matched += 1;
        } else {
            job.progress.counts.track(TrackOutcome::Conflict);
        }
    } else {
        job.progress.counts.track(TrackOutcome::Skipped);
    }
    finish_track(&tx, lease.folder_id, &job.progress, &video)?;
    prune(&tx, lease.folder_id, &mut job.progress)?;
    save(&tx, lease.folder_id, &job)?;
    tx.commit().map_err(CommandError::database)?;
    Ok(saved)
}

#[tauri::command]
pub fn linked_batch_match_job(
    database: State<'_, Database>,
    folder_id: i64,
    expected_session: String,
) -> Result<Option<LinkedMatchJob>, CommandError> {
    let c = database.0.lock().map_err(CommandError::database)?;
    account::check_account_session(&c, &expected_session)?;
    load(&c, folder_id)?
        .map(|job| view(&c, folder_id, &expected_session, job))
        .transpose()
}

#[tauri::command]
pub fn linked_batch_match_start(
    database: State<'_, Database>,
    folder_id: i64,
    expected_session: String,
    bvids: Option<Vec<String>>,
    tracks: Option<Vec<TrackInput>>,
) -> Result<LinkedMatchJob, CommandError> {
    let c = database.0.lock().map_err(CommandError::database)?;
    start(&c, folder_id, &expected_session, bvids, tracks)
}

#[tauri::command]
pub fn linked_batch_match_update(
    database: State<'_, Database>,
    folder_id: i64,
    expected_session: String,
    run_id: String,
    update: JobUpdate,
) -> Result<LinkedMatchJob, CommandError> {
    let c = database.0.lock().map_err(CommandError::database)?;
    self::update(&c, folder_id, &expected_session, &run_id, update)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        infrastructure::{
            database::account_session, migrations::migrate, repositories::lyrics::LyricsRepository,
        },
        sync::causal::{Candidate, Cell, Context, Dot, Register},
    };

    const FOLDER: i64 = 42;
    const FIRST: &str = "BV1GJ411x7h7";
    const SECOND: &str = "BV1uU3v62ENe";
    const THIRD: &str = "BV1v5wyzBESJ";

    fn setup(c: &Connection) {
        migrate(c).unwrap();
        c.execute(
            "INSERT INTO linked_bili_folders VALUES(?1,123,'测试收藏夹','[]',1)",
            [FOLDER],
        )
        .unwrap();
        contents(c, &[FIRST, SECOND, THIRD]);
    }

    fn contents(c: &Connection, bvids: &[&str]) {
        let items: Vec<_> = bvids
            .iter()
            .map(|bvid| serde_json::json!({"bvid":bvid,"title":"原始视频"}))
            .collect();
        c.execute(
            "UPDATE linked_bili_folders SET videos_json=?2 WHERE folder_id=?1",
            params![FOLDER, serde_json::to_string(&items).unwrap()],
        )
        .unwrap();
    }

    fn track(bvid: &str, cid: i64) -> TrackInput {
        TrackInput {
            id: format!("bilibili:{bvid}:{cid}"),
            bvid: bvid.to_owned(),
            aid: None,
            cid,
            page: cid as i32,
            source_title: "原始视频".into(),
            source_title_context: None,
            title: "原始视频".into(),
            artist: None,
            album: None,
            cover_url: None,
            duration_seconds: 250,
            uploader_id: None,
            uploader_name: None,
        }
    }

    fn open_memory() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        setup(&c);
        c
    }

    fn hide(c: &Connection, part: &TrackInput) {
        let rule = Register {
            seen: Context::default(),
            values: vec![Candidate {
                dot: Dot {
                    actor: uuid::Uuid::new_v4().to_string(),
                    seq: 1,
                },
                cell: Cell::Value(true.into()),
            }],
        };
        c.execute(
            "INSERT INTO content_visibility VALUES(?1,?2,?3)",
            params![
                format!("video:{}", part.bvid),
                format!("cid:{}", part.cid),
                serde_json::to_string(&rule).unwrap()
            ],
        )
        .unwrap();
    }

    fn read(c: &Connection, session: &str) -> LinkedMatchJob {
        view(c, FOLDER, session, load(c, FOLDER).unwrap().unwrap()).unwrap()
    }

    fn apply(
        c: &Connection,
        session: &str,
        run_id: &str,
        track: &TrackInput,
    ) -> Result<bool, CommandError> {
        commit(
            c,
            &MatchLease {
                folder_id: FOLDER,
                run_id: run_id.to_owned(),
                bvid: track.bvid.clone(),
            },
            session,
            &track.id,
            None,
            &MetadataPatch {
                title: "红豆".into(),
                artist: Some("王菲".into()),
                album: None,
                cover_url: None,
            },
            &SaveLyricsInput {
                provider: "qq".into(),
                provider_lyric_id: "42".into(),
                raw_text: "[00:01]歌词".into(),
                parsed_json: r#"[{"timeMs":1000,"text":"歌词"}]"#.into(),
            },
        )
    }

    #[test]
    fn the_next_part_survives_a_restart_and_a_lost_success_acknowledgment() {
        let path =
            std::env::temp_dir().join(format!("linked-matching-{}.sqlite3", uuid::Uuid::new_v4()));
        let c = Connection::open(&path).unwrap();
        setup(&c);
        let session = account_session(&c).unwrap();
        let p1 = track(FIRST, 1);
        let p2 = track(FIRST, 2);
        let start = start(
            &c,
            FOLDER,
            &session,
            Some(vec![FIRST.into(), SECOND.into()]),
            None,
        )
        .unwrap();
        assert!(start.next.unwrap().tracks.is_none());
        let run_id = start.progress.run_id;
        let resolved = update(
            &c,
            FOLDER,
            &session,
            &run_id,
            JobUpdate::Resolve {
                bvid: FIRST.into(),
                tracks: vec![p1.clone(), p2.clone()],
            },
        )
        .unwrap();
        assert_eq!(resolved.next.unwrap().tracks.unwrap()[0].id, p1.id);
        assert!(apply(&c, &session, &run_id, &p1).unwrap());
        drop(c);

        let reopened = Connection::open(&path).unwrap();
        migrate(&reopened).unwrap();
        let next_session = account_session(&reopened).unwrap();
        let paused = read(&reopened, &next_session);
        assert_eq!(paused.progress.state, JobState::Paused);
        assert_eq!(paused.progress.counts.matched, 1);
        assert_eq!(paused.next.unwrap().tracks.unwrap()[0].id, p2.id);
        assert_eq!(
            LyricsRepository::get(&reopened, &p1.id)
                .unwrap()
                .unwrap()
                .provider_lyric_id,
            "42"
        );

        let resumed = self::start(&reopened, FOLDER, &next_session, None, None).unwrap();
        assert_ne!(resumed.progress.run_id, run_id);
        assert!(apply(&reopened, &session, &run_id, &p2).is_err());
        assert!(apply(&reopened, &next_session, &run_id, &p2).is_err());
        assert!(apply(&reopened, &next_session, &resumed.progress.run_id, &p2).unwrap());
        let job = read(&reopened, &next_session);
        assert_eq!(job.progress.done, 1);
        assert_eq!(job.progress.counts.matched, 2);
        assert_eq!(job.next.unwrap().bvid, SECOND);
        drop(reopened);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn a_checkpoint_failure_also_rolls_back_the_match() {
        let c = open_memory();
        let session = account_session(&c).unwrap();
        let part = track(FIRST, 1);
        let progress = start(
            &c,
            FOLDER,
            &session,
            Some(vec![FIRST.into()]),
            Some(vec![part.clone()]),
        )
        .unwrap()
        .progress;
        c.execute_batch("CREATE TRIGGER fail_checkpoint BEFORE UPDATE ON linked_batch_match_jobs BEGIN SELECT RAISE(ABORT,'disk full'); END;").unwrap();
        assert!(apply(&c, &session, &progress.run_id, &part).is_err());
        assert!(LyricsRepository::get(&c, &part.id).unwrap().is_none());
        assert_eq!(
            read(&c, &session).next.unwrap().tracks.unwrap()[0].id,
            part.id
        );
        c.execute_batch("DROP TRIGGER fail_checkpoint").unwrap();
        assert!(apply(&c, &session, &progress.run_id, &part).unwrap());
        assert_eq!(read(&c, &session).progress.state, JobState::Completed);
    }

    #[test]
    fn a_manual_override_committed_during_matching_is_kept() {
        use crate::infrastructure::repositories::library::LibraryRepository;

        let c = open_memory();
        let session = account_session(&c).unwrap();
        let part = track(FIRST, 1);
        let progress = start(
            &c,
            FOLDER,
            &session,
            Some(vec![FIRST.into()]),
            Some(vec![part.clone()]),
        )
        .unwrap()
        .progress;
        LibraryRepository::upsert_source(&c, &part).unwrap();
        c.execute(
            "INSERT INTO metadata_overrides(track_id,title) VALUES(?1,'我的歌曲名')",
            [&part.id],
        )
        .unwrap();
        assert!(!apply(&c, &session, &progress.run_id, &part).unwrap());
        assert_eq!(
            LibraryRepository::get(&c, &part.id).unwrap().unwrap().title,
            "我的歌曲名"
        );
        let progress = read(&c, &session).progress;
        assert_eq!(progress.state, JobState::Completed);
        assert_eq!(progress.counts.conflicts, 1);
        assert_eq!(progress.counts.matched, 0);
    }

    #[test]
    fn tracks_hidden_during_match_and_removed_videos_are_skipped_once() {
        let c = open_memory();
        let session = account_session(&c).unwrap();
        let p1 = track(FIRST, 1);
        let p2 = track(FIRST, 2);
        let first = start(
            &c,
            FOLDER,
            &session,
            Some(vec![FIRST.into(), SECOND.into()]),
            Some(vec![p1.clone(), p2.clone()]),
        )
        .unwrap();
        hide(&c, &p1);
        assert!(!apply(&c, &session, &first.progress.run_id, &p1).unwrap());
        assert_eq!(
            read(&c, &session).next.unwrap().tracks.unwrap()[0].id,
            p2.id
        );
        contents(&c, &[THIRD]);
        assert!(!apply(&c, &session, &first.progress.run_id, &p2).unwrap());
        let progress = read(&c, &session).progress;
        assert_eq!(progress.state, JobState::Completed);
        assert_eq!(progress.done, 2);
        assert_eq!(progress.counts.skipped, 3);
        assert_eq!(progress.counts.matched, 0);
        assert!(LyricsRepository::get(&c, &p1.id).unwrap().is_none());
        assert!(LyricsRepository::get(&c, &p2.id).unwrap().is_none());
    }

    #[test]
    fn a_part_hidden_at_resolution_stays_out_of_the_frozen_plan() {
        let c = open_memory();
        let session = account_session(&c).unwrap();
        let first = track(FIRST, 1);
        let hidden = track(FIRST, 2);
        hide(&c, &hidden);
        let job = start(&c, FOLDER, &session, Some(vec![FIRST.into()]), None).unwrap();
        let run_id = job.progress.run_id;
        update(
            &c,
            FOLDER,
            &session,
            &run_id,
            JobUpdate::Resolve {
                bvid: FIRST.into(),
                tracks: vec![first.clone(), hidden.clone()],
            },
        )
        .unwrap();
        c.execute("DELETE FROM content_visibility", []).unwrap();

        assert!(apply(&c, &session, &run_id, &first).unwrap());
        let progress = read(&c, &session).progress;
        assert_eq!(progress.state, JobState::Completed);
        assert_eq!(progress.counts.matched, 1);
        assert_eq!(progress.counts.skipped, 1);
        assert!(LyricsRepository::get(&c, &hidden.id).unwrap().is_none());
    }

    #[test]
    fn cooldown_blocks_resume_and_account_aba_cannot_mutate_the_new_run() {
        let c = open_memory();
        let session = account_session(&c).unwrap();
        let started = start(&c, FOLDER, &session, Some(vec![FIRST.into()]), None).unwrap();
        let run_id = started.progress.run_id;
        let retry_at = now_ms() + 60_000;
        update(
            &c,
            FOLDER,
            &session,
            &run_id,
            JobUpdate::Pause {
                reason: PauseReason::RateLimited,
                retry_at: Some(retry_at),
            },
        )
        .unwrap();
        let premature = start(&c, FOLDER, &session, None, None).unwrap();
        assert_eq!(premature.progress.run_id, run_id);
        assert_eq!(premature.progress.state, JobState::Paused);
        assert_eq!(premature.progress.retry_at, Some(retry_at));

        c.execute(
            "UPDATE account_session SET token=lower(hex(randomblob(16)))",
            [],
        )
        .unwrap();
        c.execute(
            "UPDATE account_session SET token=lower(hex(randomblob(16)))",
            [],
        )
        .unwrap();
        let next_session = account_session(&c).unwrap();
        assert!(update(&c, FOLDER, &session, &run_id, JobUpdate::Cancel).is_err());
        let cancelled = update(&c, FOLDER, &next_session, &run_id, JobUpdate::Cancel).unwrap();
        assert_eq!(cancelled.progress.state, JobState::Cancelled);
        assert!(cancelled.next.is_none());
        let next = start(&c, FOLDER, &next_session, Some(vec![SECOND.into()]), None).unwrap();
        assert!(update(&c, FOLDER, &next_session, &run_id, JobUpdate::Cancel).is_err());
        assert_eq!(next.next.unwrap().bvid, SECOND);
    }
}
