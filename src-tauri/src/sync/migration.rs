//! Deterministic V2 vault identity and its durable genesis marker.
use super::causal::{self, Domain, Scope};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Genesis {
    pub schema: u32,
    pub uid: String,
    pub vault: String,
    pub seed: String,
}
impl Genesis {
    pub fn new(uid: &str, target: &str) -> Result<Self, String> {
        if uid.is_empty() || !uid.bytes().all(|c| c.is_ascii_digit()) || target.is_empty() {
            return Err("同步目标身份无效".into());
        }
        let identity = serde_json::to_vec(&("bilimusic/nutstore/v2/genesis", uid, target)).unwrap();
        let digest = ring::digest::digest(&ring::digest::SHA256, &identity);
        let mut bytes = [0; 16];
        bytes.copy_from_slice(&digest.as_ref()[..16]);
        bytes[6] = (bytes[6] & 15) | 128;
        bytes[8] = (bytes[8] & 63) | 128;
        Ok(Self {
            schema: 2,
            uid: uid.into(),
            vault: uuid::Uuid::from_bytes(bytes).to_string(),
            seed: causal::hash(&identity),
        })
    }
    /// The physical remote directory identifies the vault. Local caches additionally include
    /// the authenticated principal; spelling/alias changes of that principal must not fork v2.
    pub fn for_config(cfg: &super::Config) -> Result<Self, String> {
        if cfg.provider != "webdav" {
            return Err("新版同步仅支持 WebDAV".into());
        }
        let mut url = url::Url::parse(&cfg.url).map_err(|_| "同步地址无效")?;
        if !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("同步地址无效".into());
        }
        let path = format!("{}/", url.path().trim_end_matches('/'));
        url.set_path(&path);
        Self::new(&cfg.uid, url.as_str())
    }
    pub fn scope(&self, domain: Domain) -> Scope {
        Scope {
            uid: self.uid.clone(),
            vault: self.vault.clone(),
            seed: self.seed.clone(),
            domain,
        }
    }
    pub fn path(&self) -> String {
        format!("sync-v2/{}/bootstrap/genesis.json", self.vault)
    }
    /// The marker is fixed bytes for this target. Two first writers cannot create competing vaults.
    pub async fn publish(&self, net: &super::v2_net::Client<'_>) -> Result<(), String> {
        for path in [
            "sync-v2/".to_owned(),
            format!("sync-v2/{}/", self.vault),
            format!("sync-v2/{}/bootstrap/", self.vault),
        ] {
            net.mkdir(&path).await?;
        }
        let bytes = serde_json::to_vec(self).map_err(|_| "同步协议标记编码失败")?;
        net.put(&self.path(), bytes.clone()).await?;
        if net
            .get(&self.path())
            .await?
            .is_none_or(|obj| obj.body != bytes)
        {
            return Err("新协议标记尚未确认".into());
        }
        Ok(())
    }
    pub async fn exists(&self, net: &super::v2_net::Client<'_>) -> Result<bool, String> {
        let Some(obj) = net.get(&self.path()).await? else {
            return Ok(false);
        };
        let remote: Genesis = serde_json::from_slice(&obj.body).map_err(|_| "云端协议标记无效")?;
        if &remote != self {
            return Err("云端协议身份与当前目标不匹配".into());
        }
        Ok(true)
    }
}
