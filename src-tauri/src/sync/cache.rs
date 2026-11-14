//! Disposable conditional-GET cache, isolated by remote principal and account.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize)]
pub struct Entry {
    pub etag: String,
    pub body: Vec<u8>,
    digest: String,
}
fn file(root: &Path, url: &str) -> PathBuf {
    root.join(format!("{:x}.json", md5::compute(url)))
}
pub fn load(root: &Path, url: &str) -> Option<Entry> {
    let path = file(root, url);
    if std::fs::metadata(&path).ok()?.len() > (super::dav::MAX_DOC_BYTES * 5) as u64 {
        return None;
    }
    let entry: Entry = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    (entry.body.len() <= super::dav::MAX_DOC_BYTES
        && entry.digest == format!("{:x}", md5::compute(&entry.body)))
    .then_some(entry)
}
pub fn save(root: &Path, url: &str, etag: String, body: Vec<u8>) {
    // Cache failures never prevent synchronization. Atomic rename avoids partial entries.
    let result = (|| -> std::io::Result<()> {
        std::fs::create_dir_all(root)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700))?;
        }
        let entry = Entry {
            digest: format!("{:x}", md5::compute(&body)),
            etag,
            body,
        };
        let path = file(root, url);
        let tmp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        std::fs::write(&tmp, serde_json::to_vec(&entry)?)?;
        #[cfg(target_os = "windows")]
        if path.exists() {
            std::fs::remove_file(&path)?;
        }
        std::fs::rename(tmp, path)
    })();
    if result.is_ok() {
        trim(root);
    }
}
fn trim(root: &Path) {
    // Cache is disposable; bound serialized on-disk size, including JSON expansion.
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    let mut files: Vec<_> = entries
        .filter_map(Result::ok)
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            (m.is_file() && e.path().extension().is_some_and(|s| s == "json")).then_some((
                m.modified().ok(),
                m.len(),
                e.path(),
            ))
        })
        .collect();
    let mut bytes: u64 = files.iter().map(|(_, n, _)| n).sum();
    if bytes <= 128 * 1024 * 1024 {
        return;
    }
    files.sort_by_key(|(t, _, _)| *t);
    for (_, size, path) in files {
        if bytes <= 96 * 1024 * 1024 {
            break;
        }
        if std::fs::remove_file(path).is_ok() {
            bytes = bytes.saturating_sub(size);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn corrupt_or_partial_entries_are_cache_misses() {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        save(&dir, "https://example/a", "\"1\"".into(), b"body".to_vec());
        assert_eq!(load(&dir, "https://example/a").unwrap().body, b"body");
        assert!(load(&dir, "https://example/b").is_none());
        let path = file(&dir, "https://example/a");
        let mut entry: Entry = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        entry.body[0] = b'x';
        std::fs::write(&path, serde_json::to_vec(&entry).unwrap()).unwrap();
        assert!(load(&dir, "https://example/a").is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
