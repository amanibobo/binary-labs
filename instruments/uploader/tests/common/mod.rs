#![allow(dead_code)]

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use binary_labs_uploader::{Options, Uploader, setup};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tiny_http::{Header, Request, Response, Server};

pub const TOKEN: &str = "blu_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";
pub const CODE: &str = "K7QM-4XPA";
pub const INSTRUMENT: &str = "Plate reader, room 214";
pub const LAB: &str = "Okafor Lab";

#[derive(Clone, Debug)]
pub struct Req {
    pub method: String,
    pub url: String,
    pub auth: Option<String>,
    pub body: Vec<u8>,
    pub at: Instant,
}

impl Req {
    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }

    pub fn is(&self, method: &str, path: &str) -> bool {
        self.method == method && self.url == path
    }

    /// Part number of a PUT, for either kind of part URL.
    pub fn put_part(&self) -> Option<u32> {
        if self.method != "PUT" {
            return None;
        }
        self.url.rsplit('/').next()?.parse().ok()
    }
}

pub struct Knobs {
    pub pair_ok: bool,
    pub unauthorized: bool,
    pub part_bytes: u64,
    pub max_bytes: u64,
    pub have: HashSet<String>,
    pub absolute_parts: bool,
    /// Part numbers whose next PUT answers 503.
    pub fail_puts: Vec<u32>,
    /// Statuses to answer `complete` with, in order, before accepting it.
    pub complete_statuses: Vec<u16>,
    /// A part number whose PUT hangs without an answer while this is set.
    pub stall_part: Option<u32>,
}

impl Default for Knobs {
    fn default() -> Self {
        Knobs {
            pair_ok: true,
            unauthorized: false,
            part_bytes: 1024,
            max_bytes: 524_288_000,
            have: HashSet::new(),
            absolute_parts: false,
            fail_puts: Vec::new(),
            complete_statuses: Vec::new(),
            stall_part: None,
        }
    }
}

struct Upload {
    path: String,
    store_id: String,
    parts: BTreeMap<u32, (Vec<u8>, String)>,
}

#[derive(Default)]
pub struct Inner {
    pub requests: Vec<Req>,
    pub completed: Vec<(String, Vec<u8>)>,
    pub knobs: Knobs,
    uploads: HashMap<String, Upload>,
    next_id: u32,
}

impl Inner {
    pub fn find(&self, method: &str, path: &str) -> Vec<&Req> {
        self.requests
            .iter()
            .filter(|r| r.is(method, path))
            .collect()
    }

    pub fn with_prefix(&self, method: &str, prefix: &str) -> Vec<&Req> {
        self.requests
            .iter()
            .filter(|r| r.method == method && r.url.starts_with(prefix))
            .collect()
    }

    pub fn puts(&self) -> Vec<u32> {
        self.requests.iter().filter_map(Req::put_part).collect()
    }

    pub fn checks(&self) -> Vec<Value> {
        self.find("POST", "/api/instruments/files/check")
            .iter()
            .map(|r| r.json())
            .collect()
    }
}

pub struct Mock {
    pub url: String,
    port: u16,
    inner: Arc<Mutex<Inner>>,
    server: Arc<Server>,
    thread: Option<JoinHandle<()>>,
}

impl Mock {
    pub fn start() -> Mock {
        let server = Arc::new(Server::http("127.0.0.1:0").expect("mock server starts"));
        let port = server.server_addr().to_ip().expect("ip address").port();
        let inner = Arc::new(Mutex::new(Inner::default()));
        let thread = {
            let server = server.clone();
            let inner = inner.clone();
            std::thread::spawn(move || {
                for request in server.incoming_requests() {
                    handle(request, &inner, port);
                }
            })
        };
        Mock {
            url: format!("http://127.0.0.1:{port}"),
            port,
            inner,
            server,
            thread: Some(thread),
        }
    }

    pub fn get(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap()
    }
}

impl Drop for Mock {
    fn drop(&mut self) {
        self.server.unblock();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn handle(mut request: Request, inner: &Mutex<Inner>, port: u16) {
    let mut body = Vec::new();
    let _ = request.as_reader().read_to_end(&mut body);
    let auth = request
        .headers()
        .iter()
        .find(|h| h.field.equiv("Authorization"))
        .map(|h| h.value.as_str().to_string());
    let req = Req {
        method: request.method().as_str().to_string(),
        url: request.url().to_string(),
        auth,
        body,
        at: Instant::now(),
    };
    let stalls = |inner: &Mutex<Inner>| {
        let stall = inner.lock().unwrap().knobs.stall_part;
        stall.is_some() && stall == req.put_part()
    };
    if stalls(inner) {
        inner.lock().unwrap().requests.push(req.clone());
        while stalls(inner) {
            std::thread::sleep(Duration::from_millis(20));
        }
        return;
    }
    let mut inner = inner.lock().unwrap();
    inner.requests.push(req.clone());
    let (status, body, etag) = route(&mut inner, &req, port);
    drop(inner);
    let mut response = Response::from_data(body.to_string()).with_status_code(status);
    response.add_header(Header::from_bytes("Content-Type", "application/json").unwrap());
    if let Some(etag) = etag {
        response.add_header(Header::from_bytes("ETag", etag).unwrap());
    }
    let _ = request.respond(response);
}

fn route(inner: &mut Inner, req: &Req, port: u16) -> (u16, Value, Option<String>) {
    let segments: Vec<&str> = req.url.trim_start_matches('/').split('/').collect();
    let authed = req.auth.as_deref() == Some(format!("Bearer {TOKEN}").as_str());
    match (req.method.as_str(), segments.as_slice()) {
        ("POST", ["api", "instruments", "pair"]) => {
            if inner.knobs.pair_ok {
                let reply = json!({
                    "token": TOKEN,
                    "instrument": { "id": "11111111-2222-3333-4444-555555555555", "name": INSTRUMENT },
                    "lab": { "name": LAB },
                });
                (200, reply, None)
            } else {
                (
                    401,
                    json!({ "error": "That code is wrong or expired." }),
                    None,
                )
            }
        }
        ("PUT", ["store", id, n]) => put(inner, id, n),
        _ if inner.knobs.unauthorized || !authed => {
            (401, json!({ "error": "Unknown token." }), None)
        }
        ("POST", ["api", "instruments", "heartbeat"]) => {
            let reply = json!({
                "instrument": { "id": "1", "name": INSTRUMENT },
                "maxBytes": inner.knobs.max_bytes,
                "partBytes": inner.knobs.part_bytes,
            });
            (200, reply, None)
        }
        ("POST", ["api", "instruments", "files", "check"]) => {
            let body = req.json();
            if body["size"].as_u64().unwrap() > inner.knobs.max_bytes {
                return (413, json!({ "error": "Too large." }), None);
            }
            let have = inner.knobs.have.contains(body["path"].as_str().unwrap());
            (200, json!({ "have": have }), None)
        }
        ("POST", ["api", "instruments", "uploads"]) => {
            let body = req.json();
            let size = body["size"].as_u64().unwrap();
            if size > inner.knobs.max_bytes {
                return (413, json!({ "error": "Too large." }), None);
            }
            inner.next_id += 1;
            let id = format!("up-{}", inner.next_id);
            let store_id = format!("store-{}", inner.next_id);
            let part_bytes = inner.knobs.part_bytes;
            let parts = size.div_ceil(part_bytes).max(1);
            let upload = Upload {
                path: body["path"].as_str().unwrap().to_string(),
                store_id: store_id.clone(),
                parts: BTreeMap::new(),
            };
            inner.uploads.insert(id.clone(), upload);
            let reply = json!({ "uploadId": id, "storeId": store_id, "partBytes": part_bytes, "parts": parts });
            (200, reply, None)
        }
        ("POST", ["api", "instruments", "uploads", id, "parts", n]) => {
            let url = if inner.knobs.absolute_parts {
                format!("http://localhost:{port}/store/{id}/{n}")
            } else {
                format!("/api/instruments/uploads/{id}/parts/{n}/data/{n}")
            };
            (200, json!({ "url": url }), None)
        }
        ("PUT", ["api", "instruments", "uploads", id, "parts", n, "data", _]) => put(inner, id, n),
        ("POST", ["api", "instruments", "uploads", id, "complete"]) => {
            complete(inner, id, &req.json())
        }
        ("DELETE", ["api", "instruments", "uploads", id]) => {
            inner.uploads.remove(*id);
            (200, json!({}), None)
        }
        _ => (404, json!({ "error": "No such route." }), None),
    }
}

fn put(inner: &mut Inner, id: &str, n: &str) -> (u16, Value, Option<String>) {
    let n: u32 = n.parse().unwrap();
    let body = inner.requests.last().unwrap().body.clone();
    if let Some(i) = inner.knobs.fail_puts.iter().position(|&p| p == n) {
        inner.knobs.fail_puts.remove(i);
        return (503, json!({ "error": "Busy." }), None);
    }
    let Some(upload) = inner.uploads.get_mut(id) else {
        return (404, json!({ "error": "No such upload." }), None);
    };
    let etag = format!("\"{n}-{}\"", &sha_hex(&body)[..12]);
    upload.parts.insert(n, (body, etag.clone()));
    (200, json!({}), Some(etag))
}

fn complete(inner: &mut Inner, id: &str, body: &Value) -> (u16, Value, Option<String>) {
    if !inner.knobs.complete_statuses.is_empty() {
        let status = inner.knobs.complete_statuses.remove(0);
        inner.uploads.remove(id);
        return (status, json!({ "error": "The parts don't match." }), None);
    }
    let Some(upload) = inner.uploads.remove(id) else {
        return (409, json!({ "error": "No such upload." }), None);
    };
    let claimed: Vec<(u32, String)> = body["parts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| {
            let n = p["partNumber"].as_u64().unwrap() as u32;
            (n, p["etag"].as_str().unwrap().to_string())
        })
        .collect();
    let stored: Vec<(u32, String)> = upload
        .parts
        .iter()
        .map(|(n, (_, etag))| (*n, etag.clone()))
        .collect();
    let joined: Vec<u8> = upload
        .parts
        .values()
        .flat_map(|(bytes, _)| bytes.clone())
        .collect();
    let matches = claimed == stored
        && body["storeId"] == upload.store_id
        && body["path"] == upload.path
        && body["size"].as_u64() == Some(joined.len() as u64)
        && body["sha256"].as_str() == Some(sha_hex(&joined).as_str());
    if !matches {
        return (422, json!({ "error": "The parts don't match." }), None);
    }
    inner.completed.push((upload.path, joined));
    (
        201,
        json!({ "locationId": "loc-1", "duplicate": false }),
        None,
    )
}

pub fn sha_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// A paired config dir watching `<tmp>/Exports`. Returns (tmp, config dir, watched folder).
pub fn paired(mock: &Mock) -> (tempfile::TempDir, PathBuf, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("config");
    let folder = tmp.path().join("Exports");
    std::fs::create_dir_all(&folder).unwrap();
    setup::pair(&dir, &mock.url, CODE).unwrap();
    let folder = setup::add_folder(&dir, &folder).unwrap().path;
    (tmp, dir, folder)
}

pub fn fast() -> Options {
    Options {
        settle: Duration::ZERO,
        retry_delays: vec![Duration::ZERO],
    }
}

pub fn drain(uploader: &mut Uploader) {
    for _ in 0..10_000 {
        if !uploader.step().expect("still paired") {
            return;
        }
    }
    panic!("the uploader never went idle");
}

pub fn write(folder: &Path, rel: &str, bytes: &[u8]) -> PathBuf {
    let path = folder.join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, bytes).unwrap();
    path
}

/// Deterministic bytes that differ part to part, so a wrong range shows up as a wrong hash.
pub fn content(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i * 31 % 251) as u8).collect()
}
