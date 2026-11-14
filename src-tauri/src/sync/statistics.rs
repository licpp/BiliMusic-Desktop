//! Independent, single-writer monthly listening contributions. Never re-publish remote totals.
use super::{SyncState, active, secret, transport};
use crate::infrastructure::database::Database;
use crate::infrastructure::repositories::auth::AuthRepository;
use flate2::{Compression, read::GzDecoder, write::GzEncoder};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
};
use tauri::{AppHandle, State};
type Seconds = BTreeMap<String, f64>;
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Bucket {
    pub(super) schema: u32,
    pub(super) uid: String,
    pub(super) source: String,
    pub(super) month: String,
    pub(super) revision: u64,
    #[serde(default)]
    pub(super) plays: Seconds,
    #[serde(default)]
    pub(super) day_plays: Seconds,
    #[serde(default)]
    pub(super) daily_plays: BTreeMap<String, Seconds>,
    pub(super) tracks: Seconds,
    pub(super) days: Seconds,
    pub(super) daily: BTreeMap<String, Seconds>,
    #[serde(default)]
    pub(super) names: BTreeMap<String, (String, String)>,
}
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
pub fn init(c: &Connection, directory: &std::path::Path, uid: &str) -> Result<String, String> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS listening_buckets(source TEXT NOT NULL,month TEXT NOT NULL,json TEXT NOT NULL,owned INTEGER NOT NULL DEFAULT 0,dirty INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(source,month)); CREATE TABLE IF NOT EXISTS listening_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);").map_err(err)?;
    c.execute_batch("CREATE TABLE IF NOT EXISTS listening_source_totals(source TEXT PRIMARY KEY,seconds REAL NOT NULL); CREATE TRIGGER IF NOT EXISTS listening_bucket_insert AFTER INSERT ON listening_buckets BEGIN INSERT INTO listening_source_totals VALUES(new.source,COALESCE((SELECT SUM(value) FROM json_each(new.json,'$.days')),0)) ON CONFLICT(source) DO UPDATE SET seconds=seconds+excluded.seconds; END; CREATE TRIGGER IF NOT EXISTS listening_bucket_update AFTER UPDATE OF json ON listening_buckets BEGIN UPDATE listening_source_totals SET seconds=seconds+COALESCE((SELECT SUM(value) FROM json_each(new.json,'$.days')),0)-COALESCE((SELECT SUM(value) FROM json_each(old.json,'$.days')),0) WHERE source=new.source; END;").map_err(err)?;
    c.execute_batch("CREATE TABLE IF NOT EXISTS listening_sessions(id TEXT PRIMARY KEY,track TEXT NOT NULL,seconds REAL NOT NULL,counted INTEGER NOT NULL,updated INTEGER NOT NULL);").map_err(err)?;
    // Installation identity lives outside exported/copied databases. A restored database cannot resume an old writer.
    let path = directory.join("statistics-installation");
    let installation = match std::fs::read_to_string(&path) {
        Ok(v) => v,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            use std::fs::OpenOptions;
            let id = uuid::Uuid::new_v4().to_string();
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(mut f) => {
                    f.write_all(id.as_bytes()).map_err(err)?;
                    id
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    std::fs::read_to_string(&path).map_err(err)?
                }
                Err(e) => return Err(err(e)),
            }
        }
        Err(e) => return Err(err(e)),
    };
    let owner: Option<String> = c
        .query_row(
            "SELECT value FROM listening_meta WHERE key='installation'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(err)?;
    if owner.as_deref() != Some(&installation) {
        c.execute("UPDATE listening_buckets SET owned=0,dirty=0", [])
            .map_err(err)?;
        for (k, v) in [
            ("installation", installation),
            ("source", uuid::Uuid::new_v4().to_string()),
        ] {
            c.execute("INSERT INTO listening_meta VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![k,v]).map_err(err)?;
        }
    }
    let source: String = c
        .query_row(
            "SELECT value FROM listening_meta WHERE key='source'",
            [],
            |r| r.get(0),
        )
        .map_err(err)?;
    let migrated: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM listening_meta WHERE key='migrated')",
            [],
            |r| r.get(0),
        )
        .map_err(err)?;
    if !migrated {
        let mut b = Bucket {
            schema: 1,
            uid: uid.into(),
            source: source.clone(),
            month: "baseline".into(),
            revision: 1,
            ..Default::default()
        };
        for (table, key, target) in [
            ("listening_totals", "track_id", &mut b.tracks),
            ("listening_days", "day", &mut b.days),
        ] {
            let mut q = c
                .prepare(&format!("SELECT {key},seconds FROM {table}"))
                .map_err(err)?;
            for row in q
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?)))
                .map_err(err)?
            {
                let (k, v) = row.map_err(err)?;
                target.insert(k, v);
            }
        }
        let mut q = c
            .prepare("SELECT day,track_id,seconds FROM listening_daily")
            .map_err(err)?;
        for row in q
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, f64>(2)?,
                ))
            })
            .map_err(err)?
        {
            let (d, t, v) = row.map_err(err)?;
            b.daily.entry(d).or_default().insert(t, v);
        }
        for id in b.tracks.keys() {
            if let Ok(name)=c.query_row("SELECT COALESCE(m.title,t.title),COALESCE(m.artist,t.artist,'') FROM tracks t LEFT JOIN metadata_overrides m ON m.track_id=t.id WHERE t.id=?1",[id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))){b.names.insert(id.clone(),name);}
        }
        if !b.tracks.is_empty() {
            save(c, &b, true, true)?;
        }
        c.execute("INSERT INTO listening_meta VALUES('migrated','1')", [])
            .map_err(err)?;
    }
    Ok(source)
}
pub(super) fn save(c: &Connection, b: &Bucket, owned: bool, dirty: bool) -> Result<(), String> {
    c.execute("INSERT INTO listening_buckets VALUES(?1,?2,?3,?4,?5) ON CONFLICT(source,month) DO UPDATE SET json=excluded.json,owned=excluded.owned,dirty=excluded.dirty",params![b.source,b.month,serde_json::to_string(b).map_err(err)?,owned,dirty]).map_err(err)?;
    Ok(())
}
pub(super) fn load(c: &Connection, source: &str, month: &str) -> Result<Option<Bucket>, String> {
    c.query_row(
        "SELECT json FROM listening_buckets WHERE source=?1 AND month=?2",
        params![source, month],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .map_err(err)?
    .map(|s| serde_json::from_str(&s).map_err(err))
    .transpose()
}
pub fn record(
    c: &Connection,
    directory: &std::path::Path,
    uid: &str,
    id: &str,
    seconds: f64,
    observed_at: Option<f64>,
    session: Option<&str>,
) -> Result<(), String> {
    init(c, directory, uid)?;
    super::statistics_v2::ensure_recording_identity(c, directory, uid)?;
    let source = meta(c, "source")?.ok_or("统计来源丢失")?;
    let now: f64 = c
        .query_row("SELECT (julianday('now')-2440587.5)*86400.0", [], |r| {
            r.get(0)
        })
        .map_err(err)?;
    let end = observed_at.unwrap_or(now);
    if !end.is_finite() || end < 0.0 || !seconds.is_finite() || seconds <= 0.0 || seconds > 300.0 {
        return Err("统计采样无效".into());
    }
    let mut count_play = false;
    if let Some(session) = session.filter(|s| s.len() <= 200 && !s.is_empty()) {
        let previous: Option<(String, f64, bool)> = c
            .query_row(
                "SELECT track,seconds,counted FROM listening_sessions WHERE id=?1",
                [session],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(err)?;
        let (track, elapsed, counted) = previous.unwrap_or((id.into(), 0.0, false));
        if track == id {
            let duration = c
                .query_row(
                    "SELECT duration_seconds FROM tracks WHERE id=?1",
                    [id],
                    |r| r.get::<_, f64>(0),
                )
                .unwrap_or(0.0);
            let threshold = if duration > 0.0 {
                30.0f64.min(duration / 2.0)
            } else {
                30.0
            };
            count_play = !counted && elapsed + seconds >= threshold;
            c.execute("INSERT INTO listening_sessions VALUES(?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET seconds=excluded.seconds,counted=excluded.counted,updated=excluded.updated",params![session,id,elapsed+seconds,counted||count_play,end as i64]).map_err(err)?;
            c.execute("DELETE FROM listening_sessions WHERE id NOT IN (SELECT id FROM listening_sessions ORDER BY updated DESC LIMIT 2000)",[]).map_err(err)?;
        }
    }
    let mut start = end - seconds;
    while start < end {
        // Fixed account calendar (UTC+08:00); split elapsed samples at midnight, including month boundaries.
        let (day,next):(String,f64)=c.query_row("SELECT date(?1,'unixepoch','+8 hours'),unixepoch(date(?1,'unixepoch','+8 hours','+1 day'),'-8 hours')",[start],|r|Ok((r.get(0)?,r.get(1)?))).map_err(err)?;
        let stop = end.min(next);
        if stop <= start {
            return Err("统计日期无效".into());
        }
        let month = &day[..7];
        let count_day = day.clone();
        let mut b = load(c, &source, month)?.unwrap_or(Bucket {
            schema: 1,
            uid: uid.into(),
            source: source.clone(),
            month: month.into(),
            ..Default::default()
        });
        let value = stop - start;
        *b.tracks.entry(id.into()).or_default() += value;
        *b.days.entry(day.clone()).or_default() += value;
        *b.daily
            .entry(day)
            .or_default()
            .entry(id.into())
            .or_default() += value;
        if count_play && stop == end {
            *b.plays.entry(id.into()).or_default() += 1.0;
            *b.day_plays.entry(count_day.clone()).or_default() += 1.0;
            *b.daily_plays
                .entry(count_day)
                .or_default()
                .entry(id.into())
                .or_default() += 1.0;
        }
        b.revision += 1;
        if !b.names.contains_key(id) {
            if let Ok(name)=c.query_row("SELECT COALESCE(m.title,t.title),COALESCE(m.artist,t.artist,'') FROM tracks t LEFT JOIN metadata_overrides m ON m.track_id=t.id WHERE t.id=?1",[id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))) {b.names.insert(id.into(),name);}
        }
        save(c, &b, true, true)?;
        start = stop;
    }
    Ok(())
}
pub(super) fn buckets(c: &Connection) -> Result<Vec<Bucket>, String> {
    let mut q = c
        .prepare("SELECT json FROM listening_buckets")
        .map_err(err)?;
    q.query_map([], |r| r.get::<_, String>(0))
        .map_err(err)?
        .map(|s| serde_json::from_str(&s.map_err(err)?).map_err(err))
        .collect()
}
pub fn query(c: &Connection, directory: &std::path::Path, uid: &str) -> Result<Value, String> {
    let tx = c.unchecked_transaction().map_err(err)?;
    init(c, directory, uid)?;
    tx.commit().map_err(err)?;
    let (week,month,year,today):(String,String,String,String)=c.query_row("SELECT date('now','+8 hours','weekday 0','-6 days'),strftime('%Y-%m','now','+8 hours'),strftime('%Y','now','+8 hours'),date('now','+8 hours')",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(err)?;
    let cutoff: String = c
        .query_row("SELECT date('now','+8 hours','-90 days')", [], |r| r.get(0))
        .map_err(err)?;
    for mut b in buckets(c)? {
        let before = b.daily.len();
        b.daily.retain(|d, _| d >= &cutoff);
        b.daily_plays.retain(|d, _| d >= &cutoff);
        if before != b.daily.len() {
            let owned: bool = c
                .query_row(
                    "SELECT owned FROM listening_buckets WHERE source=?1 AND month=?2",
                    params![b.source, b.month],
                    |r| r.get(0),
                )
                .map_err(err)?;
            if owned {
                b.revision += 1;
            }
            save(c, &b, owned, owned)?;
        }
    }
    let all = buckets(c)?;
    let mut result = json!({});
    let mut names = BTreeMap::new();
    let mut daily = Seconds::new();
    for b in &all {
        names.extend(b.names.clone());
        for (d, s) in &b.days {
            *daily.entry(d.clone()).or_default() += s;
        }
    }
    for period in ["week", "month", "year", "total"] {
        let mut plays = 0.0;
        let mut tracks = Seconds::new();
        let mut days = Seconds::new();
        for b in &all {
            if period == "total"
                || (b.month != "baseline"
                    && ((period == "month" && b.month == month)
                        || (period == "year" && b.month.starts_with(&year))))
            {
                plays += b.plays.values().sum::<f64>();
                for (t, s) in &b.tracks {
                    *tracks.entry(t.clone()).or_default() += s;
                }
                for (d, s) in &b.days {
                    *days.entry(d.clone()).or_default() += s;
                }
            } else if period == "week" || b.month == "baseline" {
                for (d, n) in &b.day_plays {
                    if d <= &today
                        && match period {
                            "week" => d >= &week,
                            "month" => d.starts_with(&month),
                            "year" => d.starts_with(&year),
                            _ => false,
                        }
                    {
                        plays += n;
                    }
                }
                for (d, s) in &b.days {
                    if d <= &today
                        && match period {
                            "week" => d >= &week,
                            "month" => d.starts_with(&month),
                            "year" => d.starts_with(&year),
                            _ => false,
                        }
                    {
                        *days.entry(d.clone()).or_default() += s;
                    }
                }
                for (d, ts) in &b.daily {
                    let in_range = d <= &today
                        && match period {
                            "week" => d >= &week,
                            "month" => d.starts_with(&month),
                            "year" => d.starts_with(&year),
                            _ => false,
                        };
                    if in_range {
                        for (t, s) in ts {
                            *tracks.entry(t.clone()).or_default() += s;
                        }
                    }
                }
            }
        }
        let seconds: f64 = if period == "total" {
            c.query_row(
                "SELECT COALESCE(SUM(seconds),0) FROM listening_source_totals",
                [],
                |r| r.get(0),
            )
            .map_err(err)?
        } else {
            days.values().sum()
        };
        let count = tracks.len();
        let mut top: Vec<_> = tracks.into_iter().collect();
        top.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
        let top:Vec<Value>=top.into_iter().take(50).map(|(id,seconds)|{
            let fallback=names.get(&id).cloned().unwrap_or(("已移除的歌曲".into(),String::new()));
            let (title,artist,cover)=c.query_row("SELECT COALESCE(m.title,t.title),COALESCE(m.artist,t.artist,''),COALESCE(m.cover_url,t.cover_url,'') FROM tracks t LEFT JOIN metadata_overrides m ON m.track_id=t.id WHERE t.id=?1",[&id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?))).unwrap_or((fallback.0,fallback.1,String::new()));
            // Cached source titles also cover statistics-only songs absent from this library.
            let title = c.query_row("SELECT COALESCE(NULLIF((SELECT title FROM metadata_overrides WHERE track_id=?1),''),(SELECT value FROM sync_info WHERE key='source-title:'||?1),?2)",params![id,title],|r|r.get::<_,String>(0)).unwrap_or(title);
            json!({"id":id,"title":title,"artist":artist,"coverUrl":cover,"seconds":seconds})
        }).collect();
        result[period] =
            json!({"seconds":seconds,"tracks":count,"days":days.len(),"plays":plays,"top":top});
    }
    result["daily"] = json!(
        daily
            .into_iter()
            .map(|(day, seconds)| json!({"day":day,"seconds":seconds}))
            .collect::<Vec<_>>()
    );
    result["timezone"] = json!("Asia/Shanghai");
    let selected = selected_config(c, uid)?;
    let target = selected.as_ref().map(statistics_endpoint).transpose()?;
    let current_target = target.is_some() && meta(c, "last_target")? == target;
    let traffic = selected.as_ref().filter(|cfg| cfg.provider == "webdav").map(|cfg| -> Result<(u64,u64),String> {
        let scope = super::background::scope_key(c, cfg)?;
        c.query_row("SELECT COALESCE(SUM(uploaded),0),COALESCE(SUM(downloaded),0) FROM sync_traffic WHERE target=?1 AND domain='statistics' AND day>=date('now','-29 days')",[scope],|r|Ok((r.get(0)?,r.get(1)?))).map_err(err)
    }).transpose()?.unwrap_or((0,0));
    result["sync"] = json!({"uid":uid,"provider":selected.as_ref().map(|cfg|&cfg.provider),"paused":meta(c,"account_sync_paused")?.as_deref()==Some("1"),"enabled":selected.is_some() && meta(c,"account_sync_paused")?.as_deref()!=Some("1"),"lastSuccess":if current_target {meta(c,"last_success")?} else {None},"error":if current_target {meta(c,"error")?} else {None},"uploadedBytes":traffic.0,"downloadedBytes":traffic.1,"pending":c.query_row("SELECT COUNT(*) FROM listening_buckets WHERE owned=1 AND dirty=1",[],|r|r.get::<_,i64>(0)).map_err(err)?});
    Ok(result)
}
pub(super) fn meta(c: &Connection, key: &str) -> Result<Option<String>, String> {
    c.query_row(
        "SELECT value FROM listening_meta WHERE key=?1",
        [key],
        |r| r.get(0),
    )
    .optional()
    .map_err(err)
}
pub(super) fn put_meta(c: &Connection, key: &str, value: &str) -> Result<(), String> {
    c.execute("INSERT INTO listening_meta VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key,value]).map_err(err)?;
    Ok(())
}
pub(super) fn valid(b: &Bucket, uid: &str) -> bool {
    b.plays.len() <= 50000
        && b.plays
            .values()
            .chain(b.day_plays.values())
            .chain(b.daily_plays.values().flat_map(|m| m.values()))
            .all(|v| v.is_finite() && *v >= 0.0 && v.fract() == 0.0)
        && b.schema == 1
        && b.uid == uid
        && uuid::Uuid::parse_str(&b.source).is_ok()
        && (b.month == "baseline"
            || (b.month.len() == 7
                && b.month.as_bytes()[4] == b'-'
                && b.month
                    .bytes()
                    .enumerate()
                    .all(|(i, c)| i == 4 || c.is_ascii_digit())))
        && b.tracks.len() <= 50000
        && b.days.len() <= 36600
        && b.names.len() <= 50000
        && b.tracks
            .iter()
            .all(|(k, v)| k.len() <= 240 && v.is_finite() && *v >= 0.0)
        && b.days
            .iter()
            .all(|(d, v)| d.len() == 10 && v.is_finite() && *v >= 0.0)
        && b.daily.iter().all(|(d, ts)| {
            d.len() == 10 && ts.len() <= 50000 && ts.values().all(|v| v.is_finite() && *v >= 0.0)
        })
        && b.names
            .values()
            .all(|(t, a)| t.len() <= 4096 && a.len() <= 4096)
}
fn encode(b: &Bucket) -> Result<Vec<u8>, String> {
    let mut z = GzEncoder::new(Vec::new(), Compression::default());
    z.write_all(&serde_json::to_vec(b).map_err(err)?)
        .map_err(err)?;
    z.finish().map_err(err)
}
pub(super) fn decode(bytes: &[u8], uid: &str) -> Result<Bucket, String> {
    let mut v = Vec::new();
    GzDecoder::new(bytes)
        .take(8 * 1024 * 1024 + 1)
        .read_to_end(&mut v)
        .map_err(err)?;
    if v.len() > 8 * 1024 * 1024 {
        return Err("统计文件过大".into());
    }
    let b: Bucket = serde_json::from_slice(&v).map_err(err)?;
    if !valid(&b, uid) {
        return Err("统计文件无效".into());
    }
    Ok(b)
}
#[derive(Default, Serialize, Deserialize)]
struct Index {
    months: BTreeMap<String, u64>,
}
async fn response_bytes(mut r: reqwest::Response) -> Result<Vec<u8>, String> {
    let mut v = Vec::new();
    while let Some(chunk) = r.chunk().await.map_err(err)? {
        super::traffic::downloaded(chunk.len());
        if v.len() + chunk.len() > 2 * 1024 * 1024 {
            return Err("统计下载超过上限".into());
        }
        v.extend_from_slice(&chunk)
    }
    Ok(v)
}
// Reuse the account's chosen service, but do not gate statistics on the library merge or legacy
// opt-in flag. Pausing library synchronization does not stop collecting account contributions.
fn selected_config(c: &Connection, uid: &str) -> Result<Option<super::Config>, String> {
    if uid.is_empty() {
        return Ok(None);
    }
    let value: Option<String> = c
        .query_row("SELECT json FROM sync_settings WHERE id=1", [], |r| {
            r.get(0)
        })
        .optional()
        .map_err(err)?;
    let Some(value) = value else {
        return Ok(None);
    };
    let cfg: super::Config = serde_json::from_str(&value).map_err(err)?;
    Ok((cfg.uid == uid && (cfg.enabled || cfg.initialized)).then_some(cfg))
}
fn account_config(db: &Database) -> Result<Option<super::Config>, String> {
    let uid = std::fs::read_to_string(db.1.join("active-profile")).unwrap_or_default();
    if uid.is_empty() {
        return Ok(None);
    }
    active(db, &uid)?;
    let c = db.0.lock().map_err(err)?;
    let tx = c.unchecked_transaction().map_err(err)?;
    init(&c, &db.1, &uid)?;
    tx.commit().map_err(err)?;
    if meta(&c, "account_sync_paused")?.as_deref() == Some("1") {
        return Ok(None);
    }
    selected_config(&c, &uid)
}

pub(super) fn pause_account_sync(db: &Database, uid: &str, paused: bool) -> Result<(), String> {
    let c = db.0.lock().map_err(err)?;
    active(db, uid)?;
    init(&c, &db.1, uid)?;
    put_meta(&c, "account_sync_paused", if paused { "1" } else { "0" })
}

#[tauri::command]
pub async fn listening_sync_configure(
    database: State<'_, Database>,
    state: State<'_, SyncState>,
    uid: String,
    enabled: bool,
) -> Result<(), String> {
    // A statistics preference must not cancel or pause library synchronization.
    if let Some(token) = state.statistics_active.lock().map_err(err)?.as_ref() {
        token.cancel();
    }
    let _guard = state.statistics_gate.lock().await;
    let _account = state.account_gate.lock().await;
    pause_account_sync(&database, &uid, !enabled)
}

async fn account_credentials(
    app: &AppHandle,
    db: &Database,
    state: &SyncState,
    cfg: &super::Config,
) -> Result<transport::Secret, String> {
    // Credentials belong to the selected account/service; never silently change providers.
    let stored = {
        let _account = state.account_gate.lock().await;
        active(db, &cfg.uid)?;
        secret(app, cfg, None, false)?
    };
    if cfg.provider == "webdav" {
        return serde_json::from_str(&stored.ok_or("请在云同步设置中重新连接坚果云")?).map_err(err);
    }
    if let Some(value) = stored {
        let credentials: transport::Secret = serde_json::from_str(&value).map_err(err)?;
        let response = super::traffic::send(
            transport::client()?
                .get(transport::endpoint(cfg)?.replace("/vault", "/statistics/"))
                .bearer_auth(&credentials.password),
        )
        .await
        .map_err(|_| "无法连接账号统计服务")?;
        if response.status().is_success() {
            return Ok(credentials);
        }
        if response.status().as_u16() != 401 {
            return Err(format!(
                "账号统计服务暂不可用：HTTP {}",
                response.status().as_u16()
            ));
        }
    }
    let cookie = {
        let _account = state.account_gate.lock().await;
        active(db, &cfg.uid)?;
        let c = db.0.lock().map_err(err)?;
        AuthRepository::get_cookie(&c, "bilibili")
            .map_err(err)?
            .ok_or("请重新登录B站账号以同步统计")?
    };
    let credentials = transport::authenticate(cookie, &cfg.uid).await?;
    let _account = state.account_gate.lock().await;
    active(db, &cfg.uid)?;
    secret(
        app,
        cfg,
        Some(&serde_json::to_string(&credentials).map_err(err)?),
        false,
    )?;
    Ok(credentials)
}

#[tauri::command]
pub async fn listening_sync(
    app: AppHandle,
    database: State<'_, Database>,
    state: State<'_, SyncState>,
    automatic: Option<bool>,
) -> Result<bool, String> {
    let cfg = super::config(&database)?;
    if cfg.uid.is_empty()
        || !(cfg.enabled || cfg.initialized)
        || active(&database, &cfg.uid).is_err()
    {
        return Ok(false);
    }
    super::background::run(
        &database,
        &state,
        super::scheduler::Domain::Statistics,
        automatic.unwrap_or(false),
        listening_sync_inner(app, database.clone(), state.clone()),
        |_| (false, false),
    )
    .await
    .map(|result| result.unwrap_or(false))
}
async fn listening_sync_inner(
    app: AppHandle,
    database: State<'_, Database>,
    state: State<'_, SyncState>,
) -> Result<bool, String> {
    let _guard = state.statistics_gate.lock().await;
    let (cfg, cancellation) = {
        let _account = state.account_gate.lock().await;
        let Some(cfg) = account_config(&database)? else {
            return Ok(false);
        };
        let cancellation = tokio_util::sync::CancellationToken::new();
        *state.statistics_active.lock().map_err(err)? = Some(cancellation.clone());
        (cfg, cancellation)
    };
    let operation = async {
        let credentials = account_credentials(&app, &database, &state, &cfg).await?;
        let base = statistics_endpoint(&cfg)?;
        if cfg.provider == "webdav" {
            super::statistics_v2::exchange(&database, &cfg, &credentials).await
        } else {
            exchange(&database, &cfg, &credentials, &base).await
        }
    };
    let result =
        tokio::select! {_=cancellation.cancelled()=>Err("统计同步已取消".into()),r=operation=>r};
    let _account = state.account_gate.lock().await;
    if let Ok(c) = database.0.lock() {
        if active(&database, &cfg.uid).is_ok() {
            let target = statistics_endpoint(&cfg)?;
            if meta(&c, "last_target")?.as_deref() != Some(&target) {
                c.execute("DELETE FROM listening_meta WHERE key='last_success'", [])
                    .map_err(err)?;
            }
            put_meta(&c, "last_target", &target)?;
            let _ = put_meta(
                &c,
                "error",
                &result.as_ref().err().cloned().unwrap_or_default(),
            );
        }
    }
    *state.statistics_active.lock().map_err(err)? = None;
    result.map(|_| true)
}
fn statistics_endpoint(cfg: &super::Config) -> Result<String, String> {
    if cfg.provider == "webdav" {
        v2_endpoint(cfg)
    } else {
        Ok(transport::endpoint(cfg)?.replace("/vault", "/statistics/"))
    }
}
pub(super) fn v2_endpoint(cfg: &super::Config) -> Result<String, String> {
    Ok(format!(
        "{}/BiliMusic-sync-v1/{}/sync-v2/{}/statistics/",
        cfg.url.trim_end_matches('/'),
        cfg.uid,
        super::migration::Genesis::for_config(cfg)?.vault
    ))
}
async fn exchange(
    db: &Database,
    cfg: &super::Config,
    secret: &transport::Secret,
    base: &str,
) -> Result<(), String> {
    let http = transport::client()?;
    let request = |method: &str, url: String| {
        let r = http
            .request(reqwest::Method::from_bytes(method.as_bytes()).unwrap(), url)
            .header(
                "User-Agent",
                concat!("BiliMusic/", env!("CARGO_PKG_VERSION")),
            );
        if cfg.provider == "webdav" {
            r.basic_auth(&secret.username, Some(&secret.password))
        } else {
            r.bearer_auth(&secret.password)
        }
    };
    if cfg.provider == "webdav" {
        // Statistics may run before the first library merge; create our parents as well.
        let (account, _) = base
            .trim_end_matches('/')
            .rsplit_once('/')
            .ok_or("统计目录无效")?;
        let (application, _) = account.rsplit_once('/').ok_or("统计目录无效")?;
        for folder in [
            format!("{application}/"),
            format!("{account}/"),
            base.to_owned(),
        ] {
            let r = super::traffic::send(request("MKCOL", folder))
                .await
                .map_err(err)?;
            if !r.status().is_success() && r.status().as_u16() != 405 {
                return Err(format!("统计目录创建失败：HTTP {}", r.status().as_u16()));
            }
        }
    }
    let (source, local, cutoff) = {
        let c = db.0.lock().map_err(err)?;
        active(db, &cfg.uid)?;
        let source = meta(&c, "source")?.ok_or("统计来源丢失")?;
        let cutoff: String = c
            .query_row("SELECT date('now','+8 hours','-90 days')", [], |r| r.get(0))
            .map_err(err)?;
        (source, buckets(&c)?, cutoff)
    };
    let published_key = format!("published:{base}:{source}");
    {
        let c = db.0.lock().map_err(err)?;
        active(db, &cfg.uid)?;
        if meta(&c, &published_key)?.is_none() {
            c.execute("UPDATE listening_buckets SET dirty=1 WHERE owned=1", [])
                .map_err(err)?;
        }
    }
    let mut uploaded = 0u64;
    let mut downloaded = 0u64;
    // A reconnect to an emptied target must restore this writer's clean historical buckets too.
    let own_index = super::traffic::send(request("GET", format!("{base}index-{source}.json")))
        .await
        .map_err(err)?;
    if own_index.status().as_u16() == 404 {
        let c = db.0.lock().map_err(err)?;
        active(db, &cfg.uid)?;
        c.execute("UPDATE listening_buckets SET dirty=1 WHERE owned=1", [])
            .map_err(err)?;
        c.execute("DELETE FROM listening_meta WHERE key=?1", [&published_key])
            .map_err(err)?;
    } else if own_index.status().is_success() {
        downloaded += response_bytes(own_index).await?.len() as u64;
    } else {
        return Err(format!("统计索引检查失败：{}", own_index.status()));
    }

    // Prune detail independently; permanent month and day totals never expire.
    for mut b in local.into_iter().filter(|b| b.source == source) {
        let before = b.daily.len();
        b.daily.retain(|d, _| d >= &cutoff);
        b.daily_plays.retain(|d, _| d >= &cutoff);
        let dirty = {
            let c = db.0.lock().map_err(err)?;
            c.query_row(
                "SELECT dirty FROM listening_buckets WHERE source=?1 AND month=?2",
                params![source, b.month],
                |r| r.get::<_, bool>(0),
            )
            .map_err(err)?
        };
        if !dirty && before == b.daily.len() {
            continue;
        }
        if before != b.daily.len() {
            b.revision += 1;
            let c = db.0.lock().map_err(err)?;
            active(db, &cfg.uid)?;
            if let Some(current) = load(&c, &source, &b.month)? {
                if current.revision + 1 == b.revision {
                    save(&c, &b, true, true)?;
                } else {
                    continue;
                }
            }
        }
        let bytes = encode(&b)?;
        uploaded += bytes.len() as u64;
        if cfg.provider == "webdav" {
            let r = super::traffic::send(request("MKCOL", format!("{base}{source}/")))
                .await
                .map_err(err)?;
            if !r.status().is_success() && r.status().as_u16() != 405 {
                return Err("无法创建统计来源目录".into());
            }
        }
        let r = super::traffic::send(
            request("PUT", format!("{base}{source}/{}.json.gz", b.month))
                .header("Content-Type", "application/gzip")
                .body(bytes),
        )
        .await
        .map_err(err)?;
        if !r.status().is_success() {
            return Err(format!("统计上传失败：{}", r.status()));
        }
        // A successful PUT does not acknowledge samples recorded while it was in flight.
        let c = db.0.lock().map_err(err)?;
        active(db, &cfg.uid)?;
        put_meta(
            &c,
            &format!("ack:{base}:{}:{}", source, b.month),
            &b.revision.to_string(),
        )?;
        if load(&c, &source, &b.month)?.is_some_and(|v| v.revision == b.revision) {
            c.execute(
                "UPDATE listening_buckets SET dirty=0 WHERE source=?1 AND month=?2",
                params![source, b.month],
            )
            .map_err(err)?;
        }
    }
    // Publish all acknowledged revisions. Failed index publication is retried even if buckets are clean.
    let index = {
        let c = db.0.lock().map_err(err)?;
        active(db, &cfg.uid)?;
        let mut index = Index::default();
        for b in buckets(&c)?.into_iter().filter(|b| b.source == source) {
            if let Some(ack) = meta(&c, &format!("ack:{base}:{}:{}", source, b.month))? {
                index.months.insert(b.month, ack.parse().map_err(err)?);
            }
        }
        index
    };
    let index_json = serde_json::to_string(&index).map_err(err)?;
    let publish = {
        let c = db.0.lock().map_err(err)?;
        active(db, &cfg.uid)?;
        meta(&c, &published_key)?.as_deref() != Some(&index_json)
    };
    if publish {
        let r = super::traffic::send(
            request("PUT", format!("{base}index-{source}.json"))
                .header("Content-Type", "application/json")
                .body(index_json.clone()),
        )
        .await
        .map_err(err)?;
        if !r.status().is_success() {
            return Err("统计索引上传失败".into());
        }
        uploaded += index_json.len() as u64;
        let c = db.0.lock().map_err(err)?;
        active(db, &cfg.uid)?;
        put_meta(&c, &published_key, &index_json)?;
    }
    let sources: Vec<String> =
        if cfg.provider == "webdav" {
            let r = super::traffic::send(request("PROPFIND", base.to_owned())
            .header("Depth", "1")
            .header("Content-Type", "application/xml")
            .body("<d:propfind xmlns:d=\"DAV:\"><d:prop><d:resourcetype/></d:prop></d:propfind>"))
            .await
            .map_err(err)?;
            if !r.status().is_success() {
                return Err("统计目录读取失败".into());
            }
            let data = response_bytes(r).await?;
            downloaded += data.len() as u64;
            let mut reader = quick_xml::Reader::from_reader(data.as_slice());
            let mut href = false;
            let mut ids = Vec::new();
            loop {
                match reader.read_event() {
                    Ok(quick_xml::events::Event::Start(e)) => {
                        href = e.local_name().as_ref() == b"href"
                    }
                    Ok(quick_xml::events::Event::Text(e)) if href => {
                        let text = e.decode().map_err(err)?;
                        let name = text.rsplit('/').next().unwrap_or("");
                        if let Some(id) = name
                            .strip_prefix("index-")
                            .and_then(|s| s.strip_suffix(".json"))
                        {
                            if uuid::Uuid::parse_str(id).is_ok() {
                                ids.push(id.to_string())
                            }
                        }
                    }
                    Ok(quick_xml::events::Event::Eof) => break,
                    Err(e) => return Err(err(e)),
                    _ => {}
                }
            }
            ids
        } else {
            let r = super::traffic::send(request("GET", base.to_owned()))
                .await
                .map_err(err)?;
            if !r.status().is_success() {
                return Err("云端统计接口暂不可用，请更新同步服务".into());
            }
            serde_json::from_slice(&response_bytes(r).await?).map_err(err)?
        };
    if sources.len() > 100 {
        return Err("统计来源超过100个".into());
    }
    for remote_source in sources {
        if remote_source == source {
            continue;
        }
        if uuid::Uuid::parse_str(&remote_source).is_err() {
            return Err("统计来源无效".into());
        }
        let cache_key = format!("etag:{base}{remote_source}");
        let etag = {
            let c = db.0.lock().map_err(err)?;
            meta(&c, &cache_key)?
        };
        let mut req = request("GET", format!("{base}index-{remote_source}.json"));
        if let Some(ref e) = etag {
            req = req.header("If-None-Match", e)
        }
        let r = super::traffic::send(req).await.map_err(err)?;
        if r.status().as_u16() == 304 {
            continue;
        }
        if !r.status().is_success() {
            return Err("统计索引读取失败".into());
        }
        let new_etag = r
            .headers()
            .get("etag")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let bytes = response_bytes(r).await?;
        downloaded += bytes.len() as u64;
        let index: Index = serde_json::from_slice(&bytes).map_err(err)?;
        if index.months.len() > 1200 {
            return Err("统计月份过多".into());
        }
        for (month, revision) in index.months {
            if month != "baseline"
                && !(month.len() == 7
                    && month.as_bytes()[4] == b'-'
                    && month
                        .bytes()
                        .enumerate()
                        .all(|(i, c)| i == 4 || c.is_ascii_digit()))
            {
                return Err("统计月份无效".into());
            }
            let current = {
                let c = db.0.lock().map_err(err)?;
                load(&c, &remote_source, &month)?
            };
            if current.as_ref().is_some_and(|b| b.revision >= revision) {
                continue;
            }
            let r = super::traffic::send(request(
                "GET",
                format!("{base}{remote_source}/{month}.json.gz"),
            ))
            .await
            .map_err(err)?;
            if !r.status().is_success() {
                return Err("统计月份下载失败".into());
            }
            let bytes = response_bytes(r).await?;
            downloaded += bytes.len() as u64;
            let mut b = decode(&bytes, &cfg.uid)?;
            if b.source != remote_source || b.month != month || b.revision < revision {
                return Err("统计版本不匹配".into());
            }
            if let Some(old) = current {
                if old
                    .tracks
                    .iter()
                    .any(|(k, v)| b.tracks.get(k).copied().unwrap_or(0.0) + 0.001 < *v)
                    || old
                        .days
                        .iter()
                        .any(|(k, v)| b.days.get(k).copied().unwrap_or(0.0) + 0.001 < *v)
                {
                    return Err("统计来源发生回退，已保留本机记录".into());
                }
            }
            b.daily.retain(|d, _| d >= &cutoff);
            b.daily_plays.retain(|d, _| d >= &cutoff);
            let c = db.0.lock().map_err(err)?;
            active(db, &cfg.uid)?;
            save(&c, &b, false, false)?;
        }
        if let Some(e) = new_etag {
            let c = db.0.lock().map_err(err)?;
            active(db, &cfg.uid)?;
            put_meta(&c, &cache_key, &e)?;
        }
    }
    let c = db.0.lock().map_err(err)?;
    active(db, &cfg.uid)?;
    for (key, n) in [("uploaded", uploaded), ("downloaded", downloaded)] {
        let prev = meta(&c, key)?
            .unwrap_or_default()
            .parse::<u64>()
            .unwrap_or(0);
        put_meta(&c, key, &(prev + n).to_string())?;
    }
    put_meta(&c, "last_target", base)?;
    put_meta(
        &c,
        "last_success",
        &c.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now')", [], |r| {
            r.get::<_, String>(0)
        })
        .map_err(err)?,
    )?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Router,
        body::Bytes,
        extract::{OriginalUri, State as HttpState},
        http::{HeaderMap, Method, StatusCode},
        response::{IntoResponse, Response},
    };
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct DavFixture {
        folders: std::collections::BTreeSet<String>,
        files: BTreeMap<String, Vec<u8>>,
        fail_index_once: bool,
        uploads: usize,
        hold_month: bool,
        month_started: Arc<tokio::sync::Notify>,
        continue_month: Arc<tokio::sync::Notify>,
    }
    async fn dav_request(
        HttpState(state): HttpState<Arc<Mutex<DavFixture>>>,
        OriginalUri(uri): OriginalUri,
        method: Method,
        headers: HeaderMap,
        body: Bytes,
    ) -> Response {
        if headers.get("authorization").and_then(|v| v.to_str().ok()) != Some("Basic dGVzdDpwYXNz")
        {
            return StatusCode::UNAUTHORIZED.into_response();
        }
        let path = uri.path().to_owned();
        let pause = {
            let mut state = state.lock().unwrap();
            if method == Method::PUT && path.ends_with(".json.gz") && state.hold_month {
                state.hold_month = false;
                Some((state.month_started.clone(), state.continue_month.clone()))
            } else {
                None
            }
        };
        if let Some((started, resume)) = pause {
            started.notify_one();
            resume.notified().await;
        }
        let mut state = state.lock().unwrap();
        if method.as_str() == "MKCOL" {
            if state.folders.contains(&path) {
                return StatusCode::METHOD_NOT_ALLOWED.into_response();
            }
            let parent = format!(
                "{}/",
                path.trim_end_matches('/').rsplit_once('/').unwrap().0
            );
            if !state.folders.contains(&parent) {
                return StatusCode::CONFLICT.into_response();
            }
            state.folders.insert(path);
            return StatusCode::CREATED.into_response();
        }
        if method.as_str() == "PROPFIND" {
            if !state.folders.contains(&path) {
                return StatusCode::NOT_FOUND.into_response();
            }
            let files: String = state
                .files
                .keys()
                .filter(|key| {
                    key.strip_prefix(&path)
                        .is_some_and(|rest| !rest.contains('/'))
                })
                .map(|key| format!("<d:response><d:href>{key}</d:href></d:response>"))
                .collect();
            return (
                StatusCode::MULTI_STATUS,
                format!("<d:multistatus xmlns:d=\"DAV:\">{files}</d:multistatus>"),
            )
                .into_response();
        }
        if method == Method::PUT {
            let parent = format!("{}/", path.rsplit_once('/').unwrap().0);
            if !state.folders.contains(&parent) {
                return StatusCode::CONFLICT.into_response();
            }
            if path.contains("/index-") && state.fail_index_once {
                state.fail_index_once = false;
                return StatusCode::SERVICE_UNAVAILABLE.into_response();
            }
            state.files.insert(path, body.to_vec());
            state.uploads += 1;
            return StatusCode::CREATED.into_response();
        }
        if method == Method::GET {
            let Some(body) = state.files.get(&path) else {
                return StatusCode::NOT_FOUND.into_response();
            };
            let etag = format!("\"{:x}\"", md5::compute(body));
            if headers.get("if-none-match").and_then(|v| v.to_str().ok()) == Some(&etag) {
                return StatusCode::NOT_MODIFIED.into_response();
            }
            return ([("etag", etag)], body.clone()).into_response();
        }
        StatusCode::METHOD_NOT_ALLOWED.into_response()
    }
    async fn dav_server() -> (String, Arc<Mutex<DavFixture>>, tokio::task::JoinHandle<()>) {
        let state = Arc::new(Mutex::new(DavFixture::default()));
        state.lock().unwrap().folders.insert("/dav/".into());
        let router = Router::new()
            .fallback(dav_request)
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let root = format!("http://{}/dav", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        (root, state, task)
    }
    fn device(uid: &str) -> Database {
        let (c, dir) = setup();
        std::fs::write(dir.join("active-profile"), uid).unwrap();
        let db = Database(Mutex::new(c), dir);
        // A connected account before the library's first merge, with the old flag still false.
        let cfg = super::super::Config {
            uid: uid.into(),
            enabled: true,
            ..Default::default()
        };
        super::super::save(&db, &cfg).unwrap();
        db
    }
    fn sample(db: &Database, uid: &str, seconds: f64) {
        let c = db.0.lock().unwrap();
        record(&c, &db.1, uid, "song", seconds, None, None).unwrap();
    }
    fn total(db: &Database, uid: &str) -> f64 {
        query(&db.0.lock().unwrap(), &db.1, uid).unwrap()["total"]["seconds"]
            .as_f64()
            .unwrap()
    }
    async fn sync_device(db: &Database, root: &str, uid: &str) -> Result<(), String> {
        let cfg = account_config(db)?.ok_or("account statistics unavailable")?;
        let base = format!("{root}/BiliMusic-sync-v1/{uid}/statistics-v1/");
        exchange(
            db,
            &cfg,
            &transport::Secret {
                username: "test".into(),
                password: "pass".into(),
            },
            &base,
        )
        .await
    }

    #[tokio::test]
    async fn four_devices_share_account_totals_with_offline_catchup_and_no_duplicate_uploads() {
        let (root, server, task) = dav_server().await;
        let devices: Vec<_> = (0..4).map(|_| device("42")).collect();
        for (i, db) in devices.iter().enumerate() {
            sample(db, "42", (i + 1) as f64 * 60.0);
        }
        // Empty WebDAV has no library parents yet. Statistics must still initialize and sync.
        for db in &devices {
            sync_device(db, &root, "42").await.unwrap();
        }
        for db in &devices {
            sync_device(db, &root, "42").await.unwrap();
            assert!((total(db, "42") - 600.0).abs() < 0.001);
            let v = query(&db.0.lock().unwrap(), &db.1, "42").unwrap();
            assert_eq!(v["total"]["tracks"], 1);
            assert_eq!(v["total"]["days"], 1);
        }
        let uploads = server.lock().unwrap().uploads;
        for db in &devices {
            sync_device(db, &root, "42").await.unwrap();
        }
        assert_eq!(
            server.lock().unwrap().uploads,
            uploads,
            "unchanged statistics must not re-upload monthly files"
        );
        sample(&devices[0], "42", 30.0);
        assert!((total(&devices[1], "42") - 600.0).abs() < 0.001);
        sync_device(&devices[0], &root, "42").await.unwrap();
        for db in &devices {
            sync_device(db, &root, "42").await.unwrap();
            assert!((total(db, "42") - 630.0).abs() < 0.001);
        }
        // Another Bilibili account in the same WebDAV account is isolated.
        let other = device("43");
        sample(&other, "43", 300.0);
        sync_device(&other, &root, "43").await.unwrap();
        sync_device(&devices[0], &root, "42").await.unwrap();
        assert!((total(&devices[0], "42") - 630.0).abs() < 0.001);
        assert!((total(&other, "43") - 300.0).abs() < 0.001);
        for db in devices.iter().chain([&other]) {
            std::fs::remove_dir_all(&db.1).unwrap();
        }
        task.abort();
    }

    #[tokio::test]
    async fn failed_index_retries_without_readding_month_and_library_pause_does_not_block_statistics()
     {
        let (root, server, task) = dav_server().await;
        let a = device("42");
        let b = device("42");
        sample(&a, "42", 60.0);
        server.lock().unwrap().fail_index_once = true;
        assert!(sync_device(&a, &root, "42").await.is_err());
        sample(&a, "42", 15.0);
        let mut library = super::super::config(&a).unwrap();
        library.enabled = false;
        library.initialized = true;
        super::super::save(&a, &library).unwrap();
        sync_device(&a, &root, "42").await.unwrap();
        sync_device(&b, &root, "42").await.unwrap();
        assert!((total(&b, "42") - 75.0).abs() < 0.001);
        pause_account_sync(&a, "42", true).unwrap();
        assert!(account_config(&a).unwrap().is_none());
        assert!(
            pause_account_sync(&a, "43", false).is_err(),
            "stale account UI cannot change this account's statistics"
        );
        pause_account_sync(&a, "42", false).unwrap();
        assert!(account_config(&a).unwrap().is_some());
        for db in [&a, &b] {
            std::fs::remove_dir_all(&db.1).unwrap();
        }
        task.abort();
    }

    #[tokio::test]
    async fn listening_during_upload_stays_pending_until_its_revision_is_published() {
        let (root, server, task) = dav_server().await;
        let a = Arc::new(device("42"));
        let b = device("42");
        sample(&a, "42", 60.0);
        let (started, resume) = {
            let mut state = server.lock().unwrap();
            state.hold_month = true;
            (state.month_started.clone(), state.continue_month.clone())
        };
        let upload = {
            let a = a.clone();
            let root = root.clone();
            tokio::spawn(async move { sync_device(&a, &root, "42").await })
        };
        tokio::time::timeout(std::time::Duration::from_secs(5), started.notified())
            .await
            .unwrap();
        sample(&a, "42", 15.0);
        resume.notify_one();
        upload.await.unwrap().unwrap();
        let pending: i64 =
            a.0.lock()
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM listening_buckets WHERE dirty=1",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
        assert_eq!(pending, 1);
        sync_device(&b, &root, "42").await.unwrap();
        assert!((total(&b, "42") - 60.0).abs() < 0.001);
        sync_device(&a, &root, "42").await.unwrap();
        sync_device(&b, &root, "42").await.unwrap();
        assert!((total(&b, "42") - 75.0).abs() < 0.001);
        for db in [&*a, &b] {
            std::fs::remove_dir_all(&db.1).unwrap();
        }
        task.abort();
    }

    #[test]
    fn no_connection_or_guest_never_silently_selects_another_provider() {
        let db = device("42");
        let cfg = account_config(&db).unwrap().unwrap();
        assert_eq!(cfg.provider, "webdav");
        assert!(!cfg.initialized);
        assert!(!cfg.statistics);
        let mut library = super::super::config(&db).unwrap();
        library.enabled = false;
        super::super::save(&db, &library).unwrap();
        assert!(account_config(&db).unwrap().is_none());
        std::fs::write(db.1.join("active-profile"), "").unwrap();
        assert!(account_config(&db).unwrap().is_none());
        std::fs::remove_dir_all(db.1).unwrap();
    }
    #[test]
    fn codec_checks_identity_and_limit() {
        let b = Bucket {
            schema: 1,
            uid: "42".into(),
            source: uuid::Uuid::new_v4().to_string(),
            month: "2026-11".into(),
            ..Default::default()
        };
        let bytes = encode(&b).unwrap();
        assert!(decode(&bytes, "42").is_ok());
        assert!(decode(&bytes, "43").is_err());
        assert!(decode(b"bad", "42").is_err());
    }
    #[test]
    fn recording_migrates_once_and_pruning_preserves_totals() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(include_str!("../../migrations/0001_initial.sql"))
            .unwrap();
        crate::sync::storage::init(&c).unwrap();
        c.execute("INSERT INTO listening_totals VALUES('song',120)", [])
            .unwrap();
        c.execute("INSERT INTO listening_days VALUES('2025-01-01',120)", [])
            .unwrap();
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir(&dir).unwrap();
        record(&c, &dir, "42", "song", 15.0, None, None).unwrap();
        record(&c, &dir, "42", "song", 15.0, None, None).unwrap();
        let v = query(&c, &dir, "42").unwrap();
        assert!((v["total"]["seconds"].as_f64().unwrap() - 150.0).abs() < 0.01);
        assert_eq!(v["total"]["tracks"], 1);
        std::fs::remove_dir_all(dir).unwrap();
    }
    fn setup() -> (Connection, std::path::PathBuf) {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(include_str!("../../migrations/0001_initial.sql"))
            .unwrap();
        crate::sync::storage::init(&c).unwrap();
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir(&dir).unwrap();
        init(&c, &dir, "42").unwrap();
        (c, dir)
    }
    #[test]
    fn monthly_replacements_are_idempotent_and_sources_add_without_double_counting_days() {
        let (c, dir) = setup();
        let day: String = c
            .query_row("SELECT date('now','+8 hours')", [], |r| r.get(0))
            .unwrap();
        let mut b = Bucket {
            schema: 1,
            uid: "42".into(),
            source: uuid::Uuid::new_v4().to_string(),
            month: day[..7].into(),
            revision: 1,
            tracks: BTreeMap::from([("song".into(), 60.0)]),
            days: BTreeMap::from([(day.clone(), 60.0)]),
            ..Default::default()
        };
        save(&c, &b, false, false).unwrap();
        save(&c, &b, false, false).unwrap();
        assert_eq!(query(&c, &dir, "42").unwrap()["total"]["seconds"], 60.0);
        b.tracks.insert("song".into(), 90.0);
        b.days.insert(day.clone(), 90.0);
        b.revision += 1;
        save(&c, &b, false, false).unwrap();
        b.source = uuid::Uuid::new_v4().to_string();
        save(&c, &b, false, false).unwrap();
        let v = query(&c, &dir, "42").unwrap();
        assert_eq!(v["total"]["seconds"], 180.0);
        assert_eq!(v["total"]["tracks"], 1);
        assert_eq!(v["total"]["days"], 1);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn samples_split_at_account_midnight_and_month_boundary() {
        let (c, dir) = setup();
        let end: f64 = c
            .query_row("SELECT unixepoch('2026-10-31 16:00:05')", [], |r| r.get(0))
            .unwrap();
        record(&c, &dir, "42", "song", 15.0, Some(end), None).unwrap();
        let source = meta(&c, "source").unwrap().unwrap();
        let october = load(&c, &source, "2026-10").unwrap().unwrap();
        let november = load(&c, &source, "2026-11").unwrap().unwrap();
        assert_eq!(october.days["2026-10-31"], 10.0);
        assert_eq!(november.days["2026-11-01"], 5.0);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn valid_play_is_once_per_session_and_restore_starts_zero_contribution() {
        let (c, dir) = setup();
        for _ in 0..3 {
            record(&c, &dir, "42", "song", 15.0, None, Some("session-one")).unwrap();
        }
        assert_eq!(query(&c, &dir, "42").unwrap()["total"]["plays"], 1.0);
        record(&c, &dir, "42", "song", 30.0, None, Some("session-two")).unwrap();
        assert_eq!(query(&c, &dir, "42").unwrap()["total"]["plays"], 2.0);
        let old = meta(&c, "source").unwrap().unwrap();
        let restored = dir.join("new-installation");
        std::fs::create_dir(&restored).unwrap();
        record(&c, &restored, "42", "song", 15.0, None, None).unwrap();
        let new = meta(&c, "source").unwrap().unwrap();
        assert_ne!(old, new);
        assert!(
            (load(
                &c,
                &new,
                &c.query_row("SELECT strftime('%Y-%m','now','+8 hours')", [], |r| r
                    .get::<_, String>(0))
                    .unwrap()
            )
            .unwrap()
            .unwrap()
            .tracks["song"]
                - 15.0)
                .abs()
                < 0.01
        );
        assert!(
            (query(&c, &restored, "42").unwrap()["total"]["seconds"]
                .as_f64()
                .unwrap()
                - 90.0)
                .abs()
                < 0.01
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn detail_expiry_keeps_lifetime_song_and_day_totals() {
        let (c, dir) = setup();
        let end: f64 = c
            .query_row("SELECT unixepoch('2020-01-01 12:00:00')", [], |r| r.get(0))
            .unwrap();
        record(&c, &dir, "42", "song", 120.0, Some(end), None).unwrap();
        let v = query(&c, &dir, "42").unwrap();
        assert_eq!(v["total"]["seconds"], 120.0);
        assert_eq!(v["total"]["tracks"], 1);
        assert!(buckets(&c).unwrap().iter().all(|b| b.daily.is_empty()));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
