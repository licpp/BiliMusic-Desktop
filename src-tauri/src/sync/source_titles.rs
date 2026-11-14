//! Local source metadata cache; never part of personal sync or listening totals.
use super::*;
use crate::infrastructure::providers::bilibili::VideoParts;

pub(super) fn save(c: &rusqlite::Connection, video: &VideoParts) -> Result<usize, String> {
    let tx = c.unchecked_transaction().map_err(|e|e.to_string())?;
    let mut changed = c.execute("INSERT INTO sync_info(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE value<>excluded.value",params![format!("source-published:{}",video.bvid),video.published_at.unwrap_or(0).to_string()]).map_err(|e|e.to_string())?;
    for part in &video.parts {
        let title = if video.parts.len() > 1 && !part.title.trim().is_empty() { &part.title } else { &video.title };
        let id = format!("bilibili:{}:{}", video.bvid, part.cid);
        changed += c.execute("UPDATE tracks SET title=?2 WHERE id=?1 AND title<>?2",params![id,title]).map_err(|e|e.to_string())?;
        let key = format!("source-title:{id}");
        changed += c.execute("INSERT INTO sync_info(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE value<>excluded.value", params![key,title]).map_err(|e|e.to_string())?;
    }
    c.execute("INSERT INTO sync_info(key,value) VALUES(?1,strftime('%s','now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [format!("source-title-checked:{}",video.bvid)]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e|e.to_string())?;
    Ok(changed)
}

pub(super) async fn hydrate(database: &Database, provider: &BilibiliProvider, ids: Vec<String>) -> Result<usize,String> {
    let videos = ids.into_iter().take(8).filter_map(|id| {
        let mut parts=id.split(':');
        if parts.next()? != "bilibili" { return None }
        let bvid=parts.next()?;
        parts.next()?.parse::<i64>().ok()?;
        if parts.next().is_some() || !bvid.starts_with("BV") || bvid.len()!=12 { return None }
        Some(bvid.to_owned())
    }).collect::<std::collections::BTreeSet<_>>();
    let profile = std::fs::read_to_string(database.1.join("active-profile")).unwrap_or_default();
    let mut changed=0;
    for bvid in videos {
        let fresh = {
            let c=database.0.lock().map_err(|_|"数据库正忙")?;
            c.query_row("SELECT CAST(value AS INTEGER)>CAST(strftime('%s','now') AS INTEGER)-604800 FROM sync_info WHERE key=?1 AND EXISTS(SELECT 1 FROM sync_info WHERE key='source-published:'||?2)",params![format!("source-title-checked:{bvid}"),bvid],|r|r.get::<_,bool>(0)).unwrap_or(false)
        };
        if fresh { continue }
        let Ok(video)=provider.video_parts(&bvid).await else { break };
        if std::fs::read_to_string(database.1.join("active-profile")).unwrap_or_default()!=profile { return Ok(0) }
        let c = database.0.lock().map_err(|_|"数据库正忙")?;
        changed += save(&c,&video)?;
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::repositories::library::{LibraryRepository,MetadataPatch,TrackInput};
    #[test]
    fn canonical_metadata_repairs_old_names_without_changing_identity_or_manual_title() {
        let mut c=rusqlite::Connection::open_in_memory().unwrap();
        crate::infrastructure::migrations::migrate(&c).unwrap();
        let input=TrackInput{id:"bilibili:BV1GFRFBREe6:38410979580".into(),bvid:"BV1GFRFBREe6".into(),cid:38410979580,page:1,aid:None,source_title:"04周旋权臣".into(),title:"04周旋权臣".into(),artist:None,album:None,cover_url:None,duration_seconds:100,uploader_id:None,uploader_name:None};
        LibraryRepository::upsert(&mut c,&input).unwrap();
        let video=VideoParts{published_at:None,bvid:input.bvid.clone(),aid:1,title:"AI喻大华 守成天子嘉庆 未删减版 04周旋权臣".into(),cover_url:String::new(),uploader_id:1,uploader_name:String::new(),season:None,parts:vec![crate::infrastructure::providers::bilibili::VideoPart{cid:input.cid,page:1,title:"四、周旋权臣".into(),duration_seconds:100,cover_url:String::new(),first_frame_url:String::new()}]};
        assert!(save(&c,&video).unwrap()>0);
        assert_eq!(LibraryRepository::get(&c,&input.id).unwrap().unwrap().title,video.title);
        assert_eq!(save(&c,&video).unwrap(),0);
        LibraryRepository::update_metadata(&c,&input.id,&MetadataPatch{title:"我的名称".into(),artist:None,album:None,cover_url:None}).unwrap();
        let mut multi=video.clone();multi.parts.push(multi.parts[0].clone());multi.parts[1].cid+=1;
        save(&c,&multi).unwrap();
        assert_eq!(LibraryRepository::get(&c,&input.id).unwrap().unwrap().title,"我的名称");
        let cached:String=c.query_row("SELECT value FROM sync_info WHERE key=?1",[format!("source-title:{}",input.id)],|r|r.get(0)).unwrap();
        assert_eq!(cached,"四、周旋权臣");
        let dir=std::env::temp_dir().join(format!("source-title-test-{}",uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        super::super::statistics::init(&c,&dir,"42").unwrap();
        let missing_id=format!("bilibili:{}:{}",video.bvid,video.parts[0].cid+1);
        let mut bucket=super::super::statistics::Bucket::default();
        bucket.schema=1;bucket.uid="42".into();bucket.source=uuid::Uuid::new_v4().to_string();bucket.month="baseline".into();bucket.revision=1;
        bucket.tracks.insert(missing_id.clone(),5340.0);
        bucket.names.insert(missing_id.clone(),("旧统计名称".into(),String::new()));
        super::super::statistics::save(&c,&bucket,false,false).unwrap();
        let report=super::super::statistics::query(&c,&dir,"42").unwrap();
        assert_eq!(report["total"]["top"][0]["title"],"四、周旋权臣");
        assert_eq!(report["total"]["top"][0]["seconds"],5340.0);
        std::fs::remove_dir_all(dir).unwrap();

        // The second part is statistics-only: cache it without creating a library row.
        assert_eq!(c.query_row("SELECT COUNT(*) FROM tracks",[],|r|r.get::<_,i64>(0)).unwrap(),1);
    }
}
