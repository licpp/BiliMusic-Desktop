//! Synthetic passive store; never contacts a real account.
use super::{Config, transport::Secret};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex},
};
pub struct Store {
    pub files: BTreeMap<String, (Vec<u8>, u64)>,
    pub dirs: BTreeSet<String>,
    pub now: u64,
    pub fail_head_once: bool,
    pub requests: Vec<(String, String)>,
    pub fault: Option<Fault>,
    pub hidden: BTreeSet<String>,
    pub delayed: BTreeMap<String, (Vec<u8>, u64)>,
    pub gate: Option<Gate>,
}
#[derive(Clone, Copy)]
pub enum Failure {
    Before(u16),
    After(u16),
    DelayPut,
    CorruptGet,
}
pub struct Fault {
    pub ordinal: Option<usize>,
    pub method: Option<String>,
    pub contains: String,
    pub failure: Failure,
}
pub struct Gate {
    pub method: String,
    pub contains: String,
    pub entered: Arc<tokio::sync::Notify>,
    pub release: Arc<tokio::sync::Notify>,
}
impl Store {
    pub fn flush_delayed(&mut self) {
        self.files.append(&mut self.delayed);
    }
}
pub async fn server() -> (
    Config,
    Secret,
    Arc<Mutex<Store>>,
    tokio::task::JoinHandle<()>,
) {
    use axum::{
        extract::State,
        http::{StatusCode, header},
        response::IntoResponse,
    };
    let store = Arc::new(Mutex::new(Store {
        files: BTreeMap::new(),
        dirs: BTreeSet::from([
            "/dav/".into(),
            "/dav/BiliMusic-sync-v1/".into(),
            "/dav/BiliMusic-sync-v1/42/".into(),
        ]),
        now: 1_700_000_000,
        fail_head_once: false,
        requests: vec![],
        fault: None,
        hidden: BTreeSet::new(),
        delayed: BTreeMap::new(),
        gate: None,
    }));
    let router = axum::Router::new()
        .fallback(
            |State(store): State<Arc<Mutex<Store>>>, request: axum::extract::Request| async move {
                let method = request.method().as_str().to_owned();
                let path = request.uri().path().to_owned();
                let directory = format!("{}/", path.trim_end_matches('/'));
                let body = axum::body::to_bytes(request.into_body(), 12 * 1024 * 1024)
                    .await
                    .unwrap();
                let gate = {
                    let mut s = store.lock().unwrap();
                    if s.gate
                        .as_ref()
                        .is_some_and(|g| g.method == method && path.contains(&g.contains))
                    {
                        s.gate.take()
                    } else {
                        None
                    }
                };
                if let Some(gate) = gate {
                    gate.entered.notify_one();
                    gate.release.notified().await;
                }
                let mut s = store.lock().unwrap();
                s.requests.push((method.clone(), path.clone()));
                let failure = if s.fault.as_ref().is_some_and(|f| {
                    f.ordinal.is_none_or(|n| n == s.requests.len())
                        && f.method.as_ref().is_none_or(|m| *m == method)
                        && path.contains(&f.contains)
                }) {
                    s.fault.take().map(|f| f.failure)
                } else {
                    None
                };
                if let Some(Failure::Before(status)) = failure {
                    return StatusCode::from_u16(status).unwrap().into_response();
                }
                if method == "PUT" && matches!(failure, Some(Failure::DelayPut)) {
                    let now = s.now;
                    s.delayed.insert(path, (body.to_vec(), now));
                    return StatusCode::SERVICE_UNAVAILABLE.into_response();
                }
                let mut response = match method.as_str() {
                    "MKCOL" => {
                        let parent = format!(
                            "{}/",
                            path.trim_end_matches('/').rsplit_once('/').unwrap().0
                        );
                        if !s.dirs.contains(&parent) {
                            StatusCode::CONFLICT.into_response()
                        } else if s.dirs.insert(path.clone()) {
                            StatusCode::CREATED.into_response()
                        } else {
                            StatusCode::METHOD_NOT_ALLOWED.into_response()
                        }
                    }
                    "PUT" => {
                        let parent = format!("{}/", path.rsplit_once('/').unwrap().0);
                        if !s.dirs.contains(&parent) {
                            return StatusCode::CONFLICT.into_response();
                        }
                        let now = s.now;
                        s.files.insert(path.clone(), (body.to_vec(), now));
                        if path.contains("/control/") && s.fail_head_once {
                            s.fail_head_once = false;
                            StatusCode::SERVICE_UNAVAILABLE.into_response()
                        } else {
                            StatusCode::CREATED.into_response()
                        }
                    }
                    "DELETE" => {
                        s.files.remove(&path);
                        StatusCode::NO_CONTENT.into_response()
                    }
                    "GET" => s
                        .files
                        .get(&path)
                        .filter(|_| !s.hidden.contains(&path))
                        .map(|(body, time)| {
                            let modified = httpdate::fmt_http_date(
                                std::time::UNIX_EPOCH + std::time::Duration::from_secs(*time),
                            );
                            (
                                StatusCode::OK,
                                [(header::LAST_MODIFIED, modified)],
                                if matches!(failure, Some(Failure::CorruptGet)) {
                                    body[..body.len() / 2].to_vec()
                                } else {
                                    body.clone()
                                },
                            )
                                .into_response()
                        })
                        .unwrap_or_else(|| StatusCode::NOT_FOUND.into_response()),
                    "PROPFIND" if s.dirs.contains(&directory) => {
                        let names = s
                            .files
                            .keys()
                            .chain(s.dirs.iter())
                            .filter(|p| {
                                p.starts_with(&directory)
                                    && !s.hidden.contains(*p)
                                    && !p[directory.len()..].trim_end_matches('/').contains('/')
                            })
                            .map(|p| format!("<d:response><d:href>{p}</d:href></d:response>"))
                            .collect::<String>();
                        (
                            StatusCode::MULTI_STATUS,
                            format!("<d:multistatus xmlns:d=\"DAV:\">{names}</d:multistatus>"),
                        )
                            .into_response()
                    }
                    _ => StatusCode::NOT_FOUND.into_response(),
                };
                if let Some(Failure::After(status)) = failure {
                    response = StatusCode::from_u16(status).unwrap().into_response();
                }
                response.headers_mut().insert(
                    header::DATE,
                    httpdate::fmt_http_date(
                        std::time::UNIX_EPOCH + std::time::Duration::from_secs(s.now),
                    )
                    .parse()
                    .unwrap(),
                );
                response
            },
        )
        .with_state(store.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/dav/", listener.local_addr().unwrap());
    let handle = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    (
        Config {
            uid: "42".into(),
            url,
            device_id: uuid::Uuid::new_v4().to_string(),
            initialized: true,
            enabled: true,
            ..Config::default()
        },
        Secret {
            username: "test".into(),
            password: "test".into(),
        },
        store,
        handle,
    )
}
