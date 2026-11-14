//! Reservation survives SQLite backup/rollback. An uncertain reservation requires a fresh actor.
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    io::Write,
    path::{Path, PathBuf},
};
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Identity {
    instance: String,
    actor: String,
    reserved: BTreeMap<String, u64>,
}
pub struct Lease {
    path: PathBuf,
    identity: Identity,
}
struct Reservation {
    path: PathBuf,
    file: Option<std::fs::File>,
}
impl Drop for Reservation {
    fn drop(&mut self) {
        drop(self.file.take());
        let _ = std::fs::remove_file(&self.path);
    }
}
impl Lease {
    pub fn open(directory: &Path, instance: &str) -> Result<Self, String> {
        if uuid::Uuid::parse_str(instance).is_err() {
            return Err("数据库实例身份无效".into());
        }
        std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
        let path = directory.join("v2-writer.json");
        let identity = match std::fs::read(&path) {
            Ok(bytes) => {
                let id: Identity =
                    serde_json::from_slice(&bytes).map_err(|_| "写入身份损坏，请恢复同步身份")?;
                if id.instance != instance {
                    return Err("数据库来源变化，需要生成新的同步写入身份".into());
                }
                id
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let id = Identity {
                    instance: instance.into(),
                    actor: uuid::Uuid::new_v4().to_string(),
                    reserved: BTreeMap::new(),
                };
                let mut file = std::fs::OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(&path)
                    .map_err(|_| "写入身份正在由另一进程创建")?;
                file.write_all(&serde_json::to_vec(&id).unwrap())
                    .map_err(|e| e.to_string())?;
                file.sync_all().map_err(|e| e.to_string())?;
                id
            }
            Err(e) => return Err(e.to_string()),
        };
        if uuid::Uuid::parse_str(&identity.actor).is_err() {
            return Err("写入身份无效".into());
        }
        Ok(Self { path, identity })
    }
    pub fn actor(&self) -> &str {
        &self.identity.actor
    }
    pub fn consistent(&self, expected: &BTreeMap<String, u64>) -> bool {
        if self.path.with_extension("reservation").exists() {
            return false;
        }
        let Ok(bytes) = std::fs::read(&self.path) else {
            return false;
        };
        let Ok(disk) = serde_json::from_slice::<Identity>(&bytes) else {
            return false;
        };
        disk.instance == self.identity.instance
            && disk.actor == self.identity.actor
            && expected
                .iter()
                .all(|(d, n)| disk.reserved.get(d).copied().unwrap_or(0) == *n)
            && disk
                .reserved
                .iter()
                .all(|(d, n)| expected.get(d).copied().unwrap_or(0) == *n)
    }
    pub fn reserve(&mut self, domain: &str, previous: u64, next: u64) -> Result<(), String> {
        let lock = self.path.with_extension("reservation");
        let file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&lock)
            .map_err(|_| "写入身份已占用或上次预留未完成，需要先恢复身份")?;
        // A crash leaves a fence. Never guess that another process stopped from a timeout.
        let _reservation = Reservation {
            path: lock,
            file: Some(file),
        };
        let disk: Identity =
            serde_json::from_slice(&std::fs::read(&self.path).map_err(|e| e.to_string())?)
                .map_err(|_| "写入身份损坏")?;
        if disk.actor != self.identity.actor
            || disk.instance != self.identity.instance
            || disk.reserved.get(domain).copied().unwrap_or(0) != previous
            || previous.checked_add(1) != Some(next)
        {
            return Err("同步序号发生回退或并发写入，需先恢复写入身份".into());
        }
        let mut next_identity = disk;
        next_identity.reserved.insert(domain.into(), next);
        let temp = self
            .path
            .with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .map_err(|e| e.to_string())?;
        file.write_all(&serde_json::to_vec(&next_identity).unwrap())
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        #[cfg(target_os = "windows")]
        if self.path.exists() {
            std::fs::remove_file(&self.path).map_err(|e| e.to_string())?;
        }
        std::fs::rename(temp, &self.path).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&self.path, std::fs::Permissions::from_mode(0o600))
                .map_err(|e| e.to_string())?;
        }
        self.identity = next_identity;
        Ok(())
    }
}
