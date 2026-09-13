use serde::Serialize;

#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PlaybackStatus {
    #[default]
    Idle,
    Resolving,
    Buffering,
    Playing,
    Paused,
    Error,
}

#[derive(Debug, Default)]
pub struct PlaybackController {
    pub status: PlaybackStatus,
    pub current_track_id: Option<String>,
}
