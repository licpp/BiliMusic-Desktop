//! Shared admission policy. Times are process-relative milliseconds, never wall-clock ordering.
use serde::{Deserialize, Serialize};

pub const SECOND: u64 = 1_000;
const MIN_GAP: u64 = 30 * SECOND;
const STATISTICS_INTERVAL: u64 = 15 * 60 * SECOND;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Domain {
    Library,
    Statistics,
}
impl Domain {
    pub fn name(self) -> &'static str {
        match self {
            Self::Library => "library",
            Self::Statistics => "statistics",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Hint {
    Tick,
    Data,
    Foreground,
    Online,
    Statistics,
    Configured,
}

#[derive(Default)]
struct Slot {
    last_attempt: Option<u64>,
    next_poll: u64,
    dirty_first: Option<u64>,
    dirty_last: u64,
    failures: u32,
    idle: u32,
    blocked: bool,
}
#[derive(Default, Serialize, Deserialize)]
pub struct Saved {
    pub failures: [u32; 2],
    pub retry_until: [u64; 2],
    pub blocked: [bool; 2],
    pub limited_until: u64,
}

#[derive(Default)]
pub struct Scheduler {
    scope: String,
    slots: [Slot; 2],
    retry_at: [u64; 2],
    limited_until: u64,
}
fn index(d: Domain) -> usize {
    match d {
        Domain::Library => 0,
        Domain::Statistics => 1,
    }
}
pub fn now() -> u64 {
    static START: std::sync::LazyLock<std::time::Instant> =
        std::sync::LazyLock::new(std::time::Instant::now);
    START.elapsed().as_millis().min(u64::MAX as u128) as u64
}
pub fn wall() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

impl Scheduler {
    pub fn scope(&self) -> &str {
        &self.scope
    }
    pub fn restore(&mut self, scope: &str, saved: Saved, now: u64, wall: u64) {
        if self.scope == scope {
            return;
        }
        *self = Self {
            scope: scope.into(),
            ..Self::default()
        };
        for i in 0..2 {
            self.slots[i].failures = saved.failures[i];
            self.slots[i].blocked = saved.blocked[i];
            self.retry_at[i] = now.saturating_add(
                saved.retry_until[i]
                    .saturating_sub(wall)
                    .min(30 * 60 * SECOND),
            );
        }
        self.limited_until = now.saturating_add(
            saved
                .limited_until
                .saturating_sub(wall)
                .min(24 * 60 * 60 * SECOND),
        );
    }
    pub fn save(&self, now: u64, wall: u64) -> Saved {
        Saved {
            failures: std::array::from_fn(|i| self.slots[i].failures),
            retry_until: std::array::from_fn(|i| {
                wall.saturating_add(self.retry_at[i].saturating_sub(now))
            }),
            blocked: std::array::from_fn(|i| self.slots[i].blocked),
            limited_until: wall.saturating_add(self.limited_until.saturating_sub(now)),
        }
    }
    pub fn hint(&mut self, hint: Hint, now: u64) {
        match hint {
            Hint::Data => {
                let s = &mut self.slots[0];
                s.dirty_first.get_or_insert(now);
                s.dirty_last = now;
            }
            Hint::Foreground | Hint::Online => {
                let library = &mut self.slots[0];
                library.next_poll = library.next_poll.min(
                    library
                        .last_attempt
                        .map_or(now, |t| t.saturating_add(MIN_GAP)),
                );
                // Successful statistics exchanges keep their 15-minute cadence.
                // Resume/reconnect may wake a failed attempt, but never erase its backoff.
                let statistics = &mut self.slots[1];
                if statistics.last_attempt.is_none() || statistics.failures > 0 {
                    statistics.next_poll = statistics.next_poll.min(
                        statistics
                            .last_attempt
                            .map_or(now, |t| t.saturating_add(MIN_GAP)),
                    );
                }
            }
            Hint::Statistics => {
                let s = &mut self.slots[1];
                s.next_poll = s
                    .next_poll
                    .min(s.last_attempt.map_or(now, |t| t.saturating_add(MIN_GAP)));
            }
            // An explicit settings action may clear auth/conflict blocking, but not a server limit.
            Hint::Configured => {
                for s in &mut self.slots {
                    s.blocked = false;
                }
            }
            Hint::Tick => {}
        }
    }
    pub fn due(&self, d: Domain, now: u64) -> bool {
        let i = index(d);
        let s = &self.slots[i];
        if s.blocked || now < self.limited_until || now < self.retry_at[i] {
            return false;
        }
        let gap = s.last_attempt.map_or(0, |t| t.saturating_add(MIN_GAP));
        let dirty = s.dirty_first.map(|first| {
            first
                .saturating_add(10 * SECOND)
                .min(s.dirty_last.saturating_add(2 * SECOND))
        });
        now >= gap && now >= dirty.map_or(s.next_poll, |t| t.min(s.next_poll))
    }
    pub fn start(&mut self, d: Domain, now: u64) {
        let s = &mut self.slots[index(d)];
        s.last_attempt = Some(now);
        s.dirty_first = None;
        // A dropped IPC/future must not cause every heartbeat to retry immediately.
        s.next_poll = now.saturating_add(MIN_GAP);
    }
    pub fn finish(
        &mut self,
        d: Domain,
        now: u64,
        changed: bool,
        failed: bool,
        blocked: bool,
        retry_after_ms: u64,
        random: u64,
    ) {
        let i = index(d);
        let s = &mut self.slots[i];
        self.limited_until = self.limited_until.max(now.saturating_add(retry_after_ms));
        s.blocked = blocked;
        if failed {
            s.failures = s.failures.saturating_add(1);
            let cap = (SECOND * (1u64 << s.failures.min(10))).min(15 * 60 * SECOND);
            self.retry_at[i] = now.saturating_add(SECOND + random % cap);
        } else {
            s.failures = 0;
            self.retry_at[i] = 0;
            s.idle = if changed { 0 } else { s.idle.saturating_add(1) };
            let interval = match d {
                Domain::Statistics => STATISTICS_INTERVAL,
                Domain::Library => (30 * SECOND * (1u64 << s.idle.min(5))).min(15 * 60 * SECOND),
            };
            s.next_poll = now.saturating_add(interval);
        }
    }
    pub fn manual_allowed(&self, now: u64) -> bool {
        now >= self.limited_until
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn continuous_edits_have_a_deadline_and_inflight_edits_survive() {
        let mut s = Scheduler::default();
        s.start(Domain::Library, 0);
        s.finish(Domain::Library, 0, false, false, false, 0, 0);
        for t in 31..40 {
            s.hint(Hint::Data, t * SECOND);
            assert!(!s.due(Domain::Library, t * SECOND));
        }
        assert!(s.due(Domain::Library, 41 * SECOND));
        s.start(Domain::Library, 41 * SECOND);
        s.hint(Hint::Data, 42 * SECOND);
        s.finish(Domain::Library, 43 * SECOND, false, false, false, 0, 0);
        assert!(s.due(Domain::Library, 71 * SECOND));
    }
    #[test]
    fn hints_cannot_bypass_backoff_or_cross_domain_server_limit() {
        let mut s = Scheduler::default();
        s.start(Domain::Statistics, 0);
        s.finish(Domain::Statistics, 0, false, true, false, 120 * SECOND, 4);
        for hint in [
            Hint::Statistics,
            Hint::Online,
            Hint::Foreground,
            Hint::Configured,
        ] {
            s.hint(hint, SECOND);
        }
        assert!(!s.due(Domain::Statistics, 60 * SECOND));
        assert!(!s.due(Domain::Library, 60 * SECOND));
        assert!(!s.manual_allowed(60 * SECOND));
        assert!(s.manual_allowed(120 * SECOND));
        assert!(s.due(Domain::Library, 120 * SECOND));
    }
    #[test]
    fn restart_bounds_clock_jumps_and_old_account_does_not_poison_new() {
        let mut s = Scheduler::default();
        s.restore(
            "a",
            Saved {
                failures: [3, 0],
                retry_until: [u64::MAX, 0],
                ..Saved::default()
            },
            0,
            10,
        );
        assert!(!s.due(Domain::Library, 100));
        assert!(s.due(Domain::Library, 30 * 60 * SECOND));
        s.restore("b", Saved::default(), 100, 10);
        assert!(s.due(Domain::Library, 100));
    }
    #[test]
    fn successful_statistics_do_not_upload_again_on_every_foreground_event() {
        let mut s = Scheduler::default();
        s.start(Domain::Statistics, 0);
        s.finish(Domain::Statistics, 0, false, false, false, 0, 0);
        for t in [30, 60, 90, 300, 600] {
            s.hint(Hint::Foreground, t * SECOND);
            s.hint(Hint::Online, t * SECOND);
            assert!(!s.due(Domain::Statistics, t * SECOND));
        }
        assert!(s.due(Domain::Statistics, 15 * 60 * SECOND));
        s.hint(Hint::Statistics, 60 * SECOND);
        assert!(s.due(Domain::Statistics, 60 * SECOND));
    }
}
