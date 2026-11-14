//! Opt-in local CDN harness: a real decoder exercises the production media proxy.
use super::*;
use axum::extract::Query;
use std::sync::atomic::AtomicU64;

struct Run {
    next: Mutex<tokio::time::Instant>,
    bytes: AtomicU64,
    requests: AtomicU64,
}

#[derive(serde::Deserialize)]
struct Plan {
    mode: String,
    profile: String,
    kind: String,
}

#[tokio::test]
#[ignore = "opt-in decoder benchmark; run with BILIMUSIC_BENCH_DIR containing fast.m4a/high.m4a/high.flac"]
async fn progressive_startup_decoder_benchmark() {
    let root = std::path::PathBuf::from(std::env::var("BILIMUSIC_BENCH_DIR").unwrap());
    let assets = Arc::new(HashMap::from([
        (
            "fast.m4a".to_owned(),
            Arc::new(std::fs::read(root.join("fast.m4a")).unwrap()),
        ),
        (
            "high.m4a".to_owned(),
            Arc::new(std::fs::read(root.join("high.m4a")).unwrap()),
        ),
        (
            "high.flac".to_owned(),
            Arc::new(std::fs::read(root.join("high.flac")).unwrap()),
        ),
    ]));
    let runs: Arc<std::sync::Mutex<HashMap<String, Arc<Run>>>> = Arc::default();
    let cache = Arc::new(
        PlaybackCache::open(
            root.join(format!("cache-{}", Uuid::new_v4())),
            root.join("cache-config.json"),
        )
        .unwrap(),
    );
    let proxy = Arc::new(MediaProxy::start_inner(Some(cache), None).await.unwrap());
    *proxy.state.client.write().await = Client::builder().no_proxy().build().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let origin = base.clone();
    let plans = runs.clone();
    let downloads = runs.clone();
    let metrics = runs.clone();
    let done = Arc::new(tokio::sync::Notify::new());
    let finish = done.clone();
    let router = Router::new()
        .route("/plan",get(move |Query(plan): Query<Plan>| {
            let proxy=proxy.clone();let origin=origin.clone();let runs=plans.clone();
            async move {
                let id=Uuid::new_v4().to_string();
                runs.lock().unwrap().insert(id.clone(),Arc::new(Run {next:Mutex::new(tokio::time::Instant::now()),bytes:AtomicU64::new(0),requests:AtomicU64::new(0)}));
                let file=if plan.kind=="flac" {"high.flac"} else {"high.m4a"};
                let source = |name:&str| super::super::providers::bilibili::PlaybackSource {
                    quality_id:if name=="fast.m4a" {30216} else if name=="high.flac" {30251} else {30280},
                    audio_url:format!("{origin}/audio/{id}/{}/{name}",plan.profile),backup_urls:vec![],
                    mime_type:if name.ends_with("flac") {"audio/flac"} else {"audio/mp4"}.into(),
                    codecs:if name.ends_with("flac") {"flac"} else {"mp4a.40.2"}.into(),
                    bandwidth:if name=="fast.m4a" {64000} else if name=="high.flac" {1300000} else {192000},
                };
                let high=source(file);let quality=high.quality_id;
                let high=proxy.register_audio(&id,"BVbenchmark",1,quality,high).await;
                let eligible=super::super::providers::bilibili::prefer_progressive_startup(if file=="high.flac" {"flac"} else {"mp4a.40.2"},if file=="high.flac" {1300000} else {192000},64000);
                let (url,upgrade)=if plan.mode=="progressive" && eligible {
                    let high=proxy.guard_upgrade(&high,if file=="high.flac" {1300000} else {192000}).await;
                    (proxy.register_audio(&id,"BVbenchmark",1,30216,source("fast.m4a")).await,Some(high))
                } else {(high,None)};
                ([(header::ACCESS_CONTROL_ALLOW_ORIGIN,"*")],axum::Json(serde_json::json!({"url":url,"upgradeUrl":upgrade,"run":id})))
            }
        }))
        .route("/audio/{run}/{profile}/{file}",get(move |Path((id,profile,file)):Path<(String,String,String)>,headers:HeaderMap| {
            let assets=assets.clone();let runs=downloads.clone();
            async move {
                let run=runs.lock().unwrap().get(&id).unwrap().clone();run.requests.fetch_add(1,Ordering::Relaxed);
                let data=assets.get(&file).unwrap().clone();let size=data.len() as u64;
                let (start,end)=byte_range(headers.get(header::RANGE).and_then(|r|r.to_str().ok()),size).unwrap();
                let (latency,rate)=if profile=="limited" {(180,65536u64)} else {(20,8*1024*1024u64)};
                tokio::time::sleep(Duration::from_millis(latency)).await;
                let stream=futures_util::stream::unfold((start,run,data),move |(offset,run,data)|async move {
                    if offset>end {return None;}
                    let next=(offset+4096).min(end+1);
                    let at={let mut at=run.next.lock().await;*at=(*at).max(tokio::time::Instant::now())+Duration::from_secs_f64((next-offset) as f64/rate as f64);*at};
                    tokio::time::sleep_until(at).await;
                    run.bytes.fetch_add(next-offset,Ordering::Relaxed);
                    Some((Ok::<_,std::io::Error>(axum::body::Bytes::copy_from_slice(&data[offset as usize..next as usize])),(next,run,data)))
                });
                Response::builder().status(206).header(header::CONTENT_RANGE,format!("bytes {start}-{end}/{size}"))
                    .header(header::CONTENT_LENGTH,end-start+1).header(header::ACCEPT_RANGES,"bytes")
                    .header(header::CONTENT_TYPE,if file.ends_with("flac") {"audio/flac"} else {"audio/mp4"})
                    .body(Body::from_stream(stream)).unwrap()
            }
        }))
        .route("/metrics",get(move || {let runs=metrics.clone();async move {
            let values:HashMap<_,_>=runs.lock().unwrap().iter().map(|(id,r)|(id.clone(),serde_json::json!({"bytes":r.bytes.load(Ordering::Relaxed),"requests":r.requests.load(Ordering::Relaxed)}))).collect();
            ([(header::ACCESS_CONTROL_ALLOW_ORIGIN,"*")],axum::Json(values))
        }}))
        .route("/finish",get(move || {let done=finish.clone();async move {done.notify_one();"finished"}}));
    std::fs::write(
        root.join("server.json"),
        serde_json::to_vec(&serde_json::json!({"base":base})).unwrap(),
    )
    .unwrap();
    println!("decoder benchmark ready: {base}");
    axum::serve(listener,router).with_graceful_shutdown(async move {
        tokio::select!{_ = done.notified()=>{},_ = tokio::time::sleep(Duration::from_secs(900))=>{}}
    }).await.unwrap();
}
