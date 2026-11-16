//! The only v2 entrypoints that fetch v1 cloud sources. Joined devices never call these.
use super::{
    Config,
    causal::{Document, Domain},
    migration::Genesis,
    statistics::{self, Bucket},
    transport::Secret,
    v2_net::Client,
};
use serde::Deserialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};
pub(super) async fn library(
    cfg: &Config,
    secret: &Secret,
    g: &Genesis,
    cache: &Path,
) -> Result<BTreeMap<Domain, Document>, String> {
    let legacy = super::dav::read_cached(cfg, secret, Some(cache)).await?;
    let dav = legacy.dav.as_ref().ok_or("旧同步因果数据缺失")?;
    let mut docs = BTreeMap::new();
    for domain in [Domain::Library, Domain::Progress] {
        let mut doc = super::migration::import_legacy(g, &dav.doc, domain)?;
        if let Some(linked) = &dav.linked {
            doc.join(&super::migration::import_legacy(g, &linked.doc, domain)?)?;
        }
        docs.insert(domain, doc);
    }
    Ok(docs)
}
pub(super) async fn statistics(
    net: &Client<'_>,
    uid: &str,
    cache: &std::path::Path,
) -> Result<Vec<Bucket>, String> {
    #[derive(Deserialize)]
    struct Index {
        months: BTreeMap<String, u64>,
    }
    let (names, _) = net.list("statistics-v1/").await?;
    let mut result = vec![];
    let sources = names
        .into_iter()
        .filter_map(|n| {
            n.strip_prefix("index-")
                .and_then(|s| s.strip_suffix(".json"))
                .filter(|s| uuid::Uuid::parse_str(s).is_ok())
                .map(str::to_owned)
        })
        .collect::<BTreeSet<_>>();
    if sources.len() > 100 {
        return Err("旧统计来源超过上限".into());
    }
    for source in sources {
        let index = net
            .get(&format!("statistics-v1/index-{source}.json"))
            .await?
            .ok_or("旧统计索引暂不可见")?;
        let index: Index = serde_json::from_slice(&index.body).map_err(|_| "旧统计索引无效")?;
        if index.months.len() > 1200 {
            return Err("旧统计月份超限".into());
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
                return Err("旧统计月份无效".into());
            }
            // First migration can contain more months than one request window.
            // Re-read the authoritative index, but retain each validated revision
            // so an interrupted migration does not download the same prefix forever.
            let key = format!("legacy-statistics:{source}:{month}:{revision}");
            let body = if let Some(entry) = super::cache::load(cache, &key) {
                super::traffic::cache_hit();
                entry.body
            } else {
                net.get(&format!("statistics-v1/{source}/{month}.json.gz"))
                    .await?
                    .ok_or("旧统计月份暂不可见")?
                    .body
            };
            let bucket = statistics::decode(&body, uid)?;
            if bucket.source != source || bucket.month != month || bucket.revision < revision {
                return Err("旧统计来源版本不符".into());
            }
            super::cache::save(cache, &key, String::new(), body);
            result.push(bucket);
        }
    }
    Ok(result)
}
