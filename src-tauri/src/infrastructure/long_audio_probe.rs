//! Opt-in AVFoundation integration endpoint; never part of the production server.
use super::*;
use crate::infrastructure::providers::bilibili::BilibiliProvider;
use axum::extract::Query;
#[derive(serde::Deserialize)]
struct Options {
    quality: Option<u32>,
    cache: Option<bool>,
    segmented: Option<bool>,
    video: Option<bool>,
    bvid: Option<String>,
    ios: Option<bool>,
}
#[tokio::test]
#[ignore = "requires a live Bilibili video and an iOS simulator AVPlayer probe"]
async fn long_audio_avplayer_probe() {
    let root = std::path::PathBuf::from(std::env::var("BILIMUSIC_LONG_AUDIO_DIR").unwrap());
    std::fs::create_dir_all(&root).unwrap();
    let bvid = std::env::var("BILIMUSIC_LONG_AUDIO_BVID").unwrap_or("BV1na4y1V7so".into());
    let provider = Arc::new(BilibiliProvider::new().unwrap());
    let detail = provider.video_parts(&bvid).await.unwrap();
    let cid = detail.parts[0].cid;
    println!(
        "long audio probe: bvid={bvid} cid={cid} seconds={}",
        detail.parts[0].duration_seconds
    );
    let cache = Arc::new(
        PlaybackCache::open(
            root.join(format!("cache-{}", Uuid::new_v4())),
            root.join("cache-config.json"),
        )
        .unwrap(),
    );
    let cached = Arc::new(MediaProxy::start_inner(Some(cache), None).await.unwrap());
    let direct = Arc::new(MediaProxy::start().await.unwrap());
    *cached.state.client.write().await = Client::builder().no_proxy().build().unwrap();
    *direct.state.client.write().await = Client::builder().no_proxy().build().unwrap();
    let listener = TcpListener::bind(format!(
        "127.0.0.1:{}",
        std::env::var("BILIMUSIC_LONG_AUDIO_PORT").unwrap_or("0".into())
    ))
    .await
    .unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let cached_base = cached.server.lock().await.base_url.clone();
    let direct_base = direct.server.lock().await.base_url.clone();
    let output = root.clone();
    let done = Arc::new(tokio::sync::Notify::new());
    let finish = done.clone();
    let router=Router::new().route("/plan",get(move |Query(options):Query<Options>|{
        let provider=provider.clone();let cached=cached.clone();let direct=direct.clone();let bvid=bvid.clone();
        async move {
            let began=Instant::now();
            let bvid=options.bvid.unwrap_or(bvid);
            let video=provider.video_parts(&bvid).await.unwrap();let cid=video.parts[0].cid;
            if options.video.unwrap_or(false) {
                let source=provider.video_probe_for_platform(&bvid,cid,options.quality.unwrap_or(0),options.ios.unwrap_or(false)).await.unwrap();
                let codecs=source.codecs.clone();let bandwidth=source.bandwidth;
                let mut url=direct.register_stream(source.video_url,source.backup_urls,source.mime_type).await;
                if options.segmented.unwrap_or(false){url=direct.platform_video_url(url,&codecs).await}
                return axum::Json(serde_json::json!({"url":url,"video":true,"bvid":bvid,"duration":video.parts[0].duration_seconds,"codecs":codecs,"bandwidth":bandwidth,"planMs":began.elapsed().as_millis()}));
            }
            let source=provider.playback_source_with_quality(&bvid,cid,options.quality.unwrap_or(0)).await.unwrap();
            let quality=source.quality_id;let bandwidth=source.bandwidth;
            let proxy=if options.cache.unwrap_or(true){cached}else{direct};
            let id=Uuid::new_v4().to_string();
            let mut url=proxy.register_audio(&id,&bvid,cid,quality,source).await;
            if options.segmented.unwrap_or(false){url=proxy.segmented_mp4(&url).await.unwrap().unwrap_or(url)}
            axum::Json(serde_json::json!({"url":url,"run":id,"bvid":bvid,"duration":video.parts[0].duration_seconds,"quality":quality,"bandwidth":bandwidth,"planMs":began.elapsed().as_millis()}))
        }
    })).route("/result",axum::routing::post(move |axum::Json(value):axum::Json<serde_json::Value>|{
        let output=output.clone();async move {
            println!("AVPLAYER_RESULT {value}");
            std::fs::write(output.join(format!("result-{}.json",Uuid::new_v4())),serde_json::to_vec_pretty(&value).unwrap()).unwrap();
            "ok"
        }
    })).route("/finish",get(move ||{let done=finish.clone();async move{done.notify_one();"finished"}}));
    std::fs::write(
        root.join("server.json"),
        serde_json::to_vec(
            &serde_json::json!({"base":base,"cachedBase":cached_base,"directBase":direct_base}),
        )
        .unwrap(),
    )
    .unwrap();
    println!("long audio probe endpoint ready");
    axum::serve(listener,router).with_graceful_shutdown(async move{
        tokio::select!{_=done.notified()=>{},_=tokio::time::sleep(Duration::from_secs(1200))=>{}}
    }).await.unwrap();
}
