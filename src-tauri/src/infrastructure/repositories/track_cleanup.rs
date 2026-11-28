use rusqlite::Connection;

/// Drop local song edits only for tracks that just lost a library reference.
/// Call within the same transaction as the removal, after installing any replacements.
pub fn collect_unreferenced(c: &Connection, ids: &[String]) -> rusqlite::Result<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let mut referenced = c.prepare(
        "SELECT EXISTS(SELECT 1 FROM favorites WHERE track_id=?1)
             OR EXISTS(SELECT 1 FROM playlist_items WHERE track_id=?1)
             OR EXISTS(SELECT 1 FROM play_history WHERE track_id=?1)
             OR EXISTS(SELECT 1 FROM local_audio WHERE track_id=?1)
             OR EXISTS(SELECT 1 FROM downloads WHERE track_id=?1)
             OR EXISTS(
                 SELECT 1 FROM tracks t JOIN source_items s ON s.id=t.source_item_id
                 WHERE t.id=?1 AND s.provider='bilibili' AND (
                     EXISTS(SELECT 1 FROM collections WHERE bvid=s.bvid)
                     OR EXISTS(SELECT 1 FROM collection_progress p WHERE p.bvid=s.bvid AND p.cid=s.cid)
                     OR EXISTS(SELECT 1 FROM source_title_cache st JOIN collections col
                         ON col.bvid='season:'||json_extract(st.season_json,'$.uploaderId')||':'||json_extract(st.season_json,'$.id')
                         WHERE st.track_id=t.id)
                     OR EXISTS(SELECT 1 FROM linked_bili_folders f, json_each(f.videos_json) v
                         WHERE json_extract(v.value,'$.bvid')=s.bvid)
                 ))",
    )?;
    let mut metadata = c.prepare("DELETE FROM metadata_overrides WHERE track_id=?1")?;
    let mut lyrics = c.prepare("DELETE FROM lyrics WHERE track_id=?1")?;
    let mut positions = c.prepare("DELETE FROM playback_positions WHERE track_id=?1")?;
    let mut chapters = c.prepare(
        "DELETE FROM saved_chapters WHERE (bvid,cid)=(
             SELECT s.bvid,s.cid FROM tracks t JOIN source_items s ON s.id=t.source_item_id
             WHERE t.id=?1 AND s.provider='bilibili')",
    )?;
    for id in ids.iter().collect::<std::collections::BTreeSet<_>>() {
        if !referenced.query_row([id], |row| row.get::<_, bool>(0))? {
            metadata.execute([id])?;
            lyrics.execute([id])?;
            positions.execute([id])?;
            chapters.execute([id])?;
        }
    }
    Ok(())
}

pub fn trim_recent(c: &Connection) -> rusqlite::Result<Vec<String>> {
    let candidates = track_ids(
        c,
        "DELETE FROM play_history WHERE track_id IN (
             SELECT track_id FROM play_history GROUP BY track_id
             ORDER BY MAX(played_at) DESC,MAX(id) DESC LIMIT -1 OFFSET 200)
         RETURNING track_id",
        [],
    )?;
    let count: i64 = c.query_row("SELECT COUNT(*) FROM play_history", [], |row| row.get(0))?;
    if count > 1000 {
        // Keep one recent row per song even if repeat plays fill the event limit.
        c.execute(
            "DELETE FROM play_history WHERE id IN (
                 SELECT id FROM (
                     SELECT id,played_at,ROW_NUMBER() OVER (
                         PARTITION BY track_id ORDER BY played_at DESC,id DESC) AS recency
                     FROM play_history)
                 ORDER BY (recency=1) DESC,played_at DESC,id DESC LIMIT -1 OFFSET 1000)",
            [],
        )?;
    }
    Ok(candidates)
}

pub fn playlist_candidates(c: &Connection, id: &str) -> rusqlite::Result<Vec<String>> {
    track_ids(
        c,
        "SELECT track_id FROM playlist_items WHERE playlist_id=?1",
        [id],
    )
}

pub fn linked_folder_candidates(c: &Connection, id: i64) -> rusqlite::Result<Vec<String>> {
    track_ids(
        c,
        "SELECT DISTINCT t.id FROM linked_bili_folders f, json_each(f.videos_json) v
         JOIN source_items s ON s.bvid=json_extract(v.value,'$.bvid') AND s.provider='bilibili'
         JOIN tracks t ON t.source_item_id=s.id WHERE f.folder_id=?1",
        [id],
    )
}

pub fn collection_candidates(c: &Connection, id: &str) -> rusqlite::Result<Vec<String>> {
    track_ids(
        c,
        "SELECT t.id FROM tracks t JOIN source_items s ON s.id=t.source_item_id
         WHERE s.provider='bilibili' AND (s.bvid=?1
            OR EXISTS(SELECT 1 FROM collection_progress p WHERE p.bvid=s.bvid AND p.cid=s.cid
                AND (?1=p.reference OR ?1=p.creator_ref))
            OR EXISTS(SELECT 1 FROM source_title_cache st WHERE st.track_id=t.id
                AND ?1='season:'||json_extract(st.season_json,'$.uploaderId')||':'||json_extract(st.season_json,'$.id')))",
        [id],
    )
}

pub fn track_ids(
    c: &Connection,
    sql: &str,
    params: impl rusqlite::Params,
) -> rusqlite::Result<Vec<String>> {
    c.prepare(sql)?
        .query_map(params, |row| row.get(0))?
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        crate::infrastructure::migrations::migrate(&c).unwrap();
        c.execute_batch(
            "INSERT INTO source_items(id,provider,bvid,cid) VALUES
                ('old','bilibili','BVold',1), ('new','bilibili','BVnew',1);
             INSERT INTO tracks(id,source_item_id,title) VALUES
                ('old','old','Old'), ('new','new','New');",
        )
        .unwrap();
        c
    }

    #[test]
    fn removing_the_last_reference_keeps_the_base_track_and_listening_totals() {
        let c = database();
        c.execute_batch(
            "INSERT INTO metadata_overrides(track_id,title) VALUES ('old','Edit'), ('new','Unrelated edit');
             INSERT INTO lyrics(track_id,provider,raw_text,parsed_json) VALUES('old','netease','Words','[]');
             INSERT INTO saved_chapters VALUES ('BVold',1,'{}'), ('BVold',2,'{}');
             INSERT INTO playback_positions VALUES ('old',36,10);
             INSERT INTO listening_totals VALUES ('old',12);
             INSERT INTO downloads(id,track_id,target_path,status) VALUES ('download','old','song.m4a','completed');
             INSERT INTO linked_bili_folders VALUES (42,1,'Folder','[{\"bvid\":\"BVold\"}]',0);
             INSERT INTO collections(bvid) VALUES ('season:30:4');
             INSERT INTO source_title_cache(track_id,video_title,part_title,part_count,season_json)
                VALUES ('old','Title','Part',1,'{\"uploaderId\":30,\"id\":4}');",
        ).unwrap();
        let candidates = linked_folder_candidates(&c, 42).unwrap();
        assert_eq!(candidates, ["old"]);
        assert_eq!(
            collection_candidates(&c, "season:30:4").unwrap(),
            candidates
        );
        let count = |sql| c.query_row(sql, [], |row| row.get::<_, i64>(0)).unwrap();
        for removed in [
            "DELETE FROM downloads",
            "DELETE FROM linked_bili_folders",
            "DELETE FROM collections",
        ] {
            collect_unreferenced(&c, &candidates).unwrap();
            assert_eq!(count("SELECT COUNT(*) FROM metadata_overrides"), 2);
            assert_eq!(count("SELECT COUNT(*) FROM saved_chapters"), 2);
            c.execute(removed, []).unwrap();
        }
        collect_unreferenced(&c, &candidates).unwrap();
        assert_eq!(
            count("SELECT COUNT(*) FROM metadata_overrides WHERE track_id='old'"),
            0
        );
        assert_eq!(count("SELECT COUNT(*) FROM lyrics"), 0);
        assert_eq!(count("SELECT COUNT(*) FROM playback_positions"), 0);
        assert_eq!(count("SELECT COUNT(*) FROM saved_chapters WHERE cid=2"), 1);
        assert_eq!(count("SELECT COUNT(*) FROM saved_chapters"), 1);
        assert_eq!(count("SELECT COUNT(*) FROM tracks"), 2);
        assert_eq!(count("SELECT COUNT(*) FROM listening_totals"), 1);
        assert_eq!(
            count("SELECT COUNT(*) FROM metadata_overrides WHERE track_id='new'"),
            1
        );
    }

    #[test]
    fn repeated_plays_do_not_evict_distinct_tracks_before_the_recent_limit() {
        let c = database();
        c.execute_batch(
            "INSERT INTO play_history(track_id,played_at) VALUES ('old','2000-01-01');
             WITH RECURSIVE plays(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM plays WHERE i<1000)
             INSERT INTO play_history(track_id,played_at) SELECT 'new','2026-01-01' FROM plays;",
        )
        .unwrap();
        assert!(trim_recent(&c).unwrap().is_empty());
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM play_history", [], |r| r
                .get::<_, usize>(0))
                .unwrap(),
            1000
        );
        assert_eq!(
            c.query_row(
                "SELECT COUNT(DISTINCT track_id) FROM play_history",
                [],
                |r| r.get::<_, usize>(0)
            )
            .unwrap(),
            2
        );
    }
}
