pub mod account;
pub mod commands;
pub mod downloads;
pub mod error;
pub mod linked_folders;

#[cfg(all(desktop, not(target_env = "ohos")))]
pub mod local_playlist;
pub mod media;
pub mod playback;
pub mod playback_cache;
pub mod playlist_import;

pub mod recommendation;

pub mod list_preferences;

mod playlist_sources;

pub mod chapters;
pub mod visibility;

pub mod imported_entries;

pub mod batch_matching;
pub mod diagnostics;
pub mod linked_batch_matching;
