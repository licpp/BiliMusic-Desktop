use super::error::CommandError;
use super::playlist_import::{ExternalPlaylist, ExternalSong, MAX_SONGS};
use lofty::{
    config::ParseOptions,
    file::{AudioFile, TaggedFileExt},
    probe::Probe,
    tag::Accessor,
};
use std::{collections::HashSet, path::Path};
use tauri_plugin_dialog::DialogExt;

fn is_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "mp3"
                    | "flac"
                    | "m4a"
                    | "aac"
                    | "ogg"
                    | "opus"
                    | "wav"
                    | "aif"
                    | "aiff"
                    | "ape"
                    | "mpc"
                    | "wv"
            )
        })
}

fn filename_metadata(stem: &str) -> (&str, &str) {
    let stem = stem.trim();
    let rest = stem.trim_start_matches(|ch: char| ch.is_ascii_digit());
    let digits = stem.len() - rest.len();
    let numbered = (1..=3).contains(&digits) && rest.starts_with(['.', '、'])
        || digits == 2 && stem.starts_with('0') && rest.starts_with(' ');
    let stem = if numbered {
        rest.trim_start_matches([' ', '.', '、'])
    } else {
        stem
    };
    stem.split_once(" - ")
        .filter(|(artist, title)| !artist.trim().is_empty() && !title.trim().is_empty())
        .map(|(artist, title)| (title.trim(), artist.trim()))
        .unwrap_or((stem, ""))
}

fn metadata(path: &Path) -> Option<ExternalSong> {
    let stem = path.file_stem()?.to_string_lossy();
    let (file_title, file_artist) = filename_metadata(&stem);
    let tagged = Probe::open(path)
        .and_then(|probe| {
            probe
                .options(ParseOptions::new().read_cover_art(false))
                .read()
        })
        .ok();
    let tag = tagged
        .as_ref()
        .and_then(|file| file.primary_tag().or_else(|| file.first_tag()));
    let title = tag
        .and_then(Accessor::title)
        .filter(|item| !item.trim().is_empty());
    let artist = tag
        .and_then(Accessor::artist)
        .filter(|item| !item.trim().is_empty());
    let album = tag
        .and_then(Accessor::album)
        .map(|item| item.trim().to_owned())
        .filter(|item| !item.is_empty() && item.len() <= 2000);
    let title = title.as_deref().unwrap_or(file_title).trim();
    if title.is_empty() || title.chars().count() > 1000 {
        return None;
    }
    let artists: Vec<_> = artist
        .as_deref()
        .unwrap_or(file_artist)
        .replace(" / ", "、")
        .split(['、', ';', '；'])
        .map(str::trim)
        .filter(|item| !item.is_empty() && item.len() <= 1000)
        .take(50)
        .map(str::to_owned)
        .collect();
    let duration_seconds = tagged
        .as_ref()
        .map(|file| file.properties().duration().as_secs_f64())
        .filter(|value| *value <= 604800.0)
        .unwrap_or_default();
    let identity = format!(
        "{}\n{}\n{}\n{}",
        title.to_lowercase(),
        artists.join(" / ").to_lowercase(),
        album.as_deref().unwrap_or_default().to_lowercase(),
        duration_seconds.round()
    );
    Some(ExternalSong {
        source_id: format!("local-file:{:x}", md5::compute(identity.as_bytes())),
        title: title.into(),
        artists,
        aliases: Vec::new(),
        duration_seconds,
        album,
        cover_url: None,
    })
}

fn scan_local_playlist(directory: &Path) -> Result<ExternalPlaylist, CommandError> {
    std::fs::read_dir(directory).map_err(|_| CommandError::validation("无法读取所选文件夹"))?;
    let mut songs = Vec::new();
    let mut scanned = 0;
    let mut unavailable = 0;
    let mut seen = HashSet::new();
    for entry in walkdir::WalkDir::new(directory)
        .sort_by_file_name()
        .min_depth(1)
    {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                unavailable += 1;
                continue;
            }
        };
        if !entry.file_type().is_file() || !is_audio(entry.path()) {
            continue;
        }
        scanned += 1;
        if scanned > MAX_SONGS {
            return Err(CommandError::validation(
                "一次最多读取 5000 首，请选择更小的文件夹",
            ));
        }
        match metadata(entry.path()) {
            Some(song) if seen.insert(song.source_id.clone()) => songs.push(song),
            Some(_) => (),
            None => unavailable += 1,
        }
    }
    if songs.is_empty() {
        return Err(CommandError::validation("所选文件夹没有可匹配的音频文件"));
    }
    let name = directory
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "本地歌曲".into());
    Ok(ExternalPlaylist {
        name,
        source: "text".into(),
        reported_count: songs.len() + unavailable,
        songs,
        unavailable_count: unavailable,
    })
}

#[tauri::command]
pub async fn local_playlist_pick(
    window: tauri::Window,
) -> Result<Option<ExternalPlaylist>, CommandError> {
    let (sender, result) = tokio::sync::oneshot::channel();
    window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("选择本地音乐文件夹")
        .pick_folder(move |folder| {
            let _ = sender.send(folder);
        });
    let selection = result.await.map_err(CommandError::provider)?;
    let Some(folder) = selection else {
        return Ok(None);
    };
    let directory = folder.into_path().map_err(CommandError::provider)?;
    tauri::async_runtime::spawn_blocking(move || scan_local_playlist(&directory))
        .await
        .map_err(CommandError::provider)?
        .map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    use lofty::{
        config::WriteOptions,
        tag::{Tag, TagExt, TagType},
    };
    use std::fs;

    #[test]
    fn local_import_scans_subfolders_prefers_tags_and_uses_filename_fallback() {
        let root = std::env::temp_dir().join(format!("bili-local-import-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("专辑")).unwrap();
        let tagged = root.join("01. Other - Filename.wav");
        let data_size = 16_000_u32;
        let mut wav = b"RIFF".to_vec();
        wav.extend((36 + data_size).to_le_bytes());
        wav.extend(b"WAVEfmt ");
        wav.extend(16_u32.to_le_bytes());
        wav.extend(1_u16.to_le_bytes());
        wav.extend(1_u16.to_le_bytes());
        wav.extend(8_000_u32.to_le_bytes());
        wav.extend(16_000_u32.to_le_bytes());
        wav.extend(2_u16.to_le_bytes());
        wav.extend(16_u16.to_le_bytes());
        wav.extend(b"data");
        wav.extend(data_size.to_le_bytes());
        wav.resize(wav.len() + data_size as usize, 0);
        fs::write(&tagged, wav).unwrap();
        let mut tag = Tag::new(TagType::Id3v2);
        tag.set_title("标签歌名".into());
        tag.set_artist("标签歌手".into());
        tag.set_album("标签专辑".into());
        tag.save_to_path(&tagged, WriteOptions::default()).unwrap();
        fs::write(root.join("专辑/02. 回退歌手 - 回退歌名.MP3"), b"").unwrap();
        fs::write(root.join("专辑/备注.txt"), b"ignore").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&tagged, root.join("副本.wav")).unwrap();
        let result = scan_local_playlist(&root);
        fs::remove_dir_all(&root).unwrap();
        let playlist = result.unwrap();
        assert_eq!(playlist.songs.len(), 2);
        assert_eq!(playlist.songs[0].title, "标签歌名");
        assert_eq!(playlist.songs[0].artists, ["标签歌手"]);
        assert_eq!(playlist.songs[0].album.as_deref(), Some("标签专辑"));
        assert_eq!(playlist.songs[0].duration_seconds, 1.0);
        assert_eq!(playlist.songs[1].title, "回退歌名");
        assert_eq!(playlist.songs[1].artists, ["回退歌手"]);
        assert_eq!(filename_metadata("99 Luftballons"), ("99 Luftballons", ""));
    }
}
