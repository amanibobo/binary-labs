use std::fmt;
use std::io;
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::json;
use ureq::http::Response;
use ureq::{Agent, Body};

use crate::config::{Instrument, Lab, Token};
use crate::state::Session;

/// Why a request didn't succeed, sorted by what the uploader does next.
#[derive(Debug)]
pub enum Failure {
    Unpaired,
    TooLarge,
    Rejected {
        status: u16,
        message: String,
    },
    Transient {
        reason: String,
        retry_after: Option<Duration>,
    },
}

impl fmt::Display for Failure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Failure::Unpaired => f.write_str("the uploader isn't paired any more"),
            Failure::TooLarge => f.write_str("the file is larger than the lab allows"),
            Failure::Rejected { status, message } => {
                write!(f, "the server refused it ({status}: {message})")
            }
            Failure::Transient { reason, .. } => f.write_str(reason),
        }
    }
}

impl From<io::Error> for Failure {
    fn from(e: io::Error) -> Self {
        Failure::Transient {
            reason: format!("couldn't read the file ({e})"),
            retry_after: None,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo<'a> {
    pub path: &'a str,
    pub sha256: &'a str,
    pub size: u64,
    pub modified_at: i64,
}

#[derive(Deserialize)]
pub struct PairReply {
    pub token: Token,
    pub instrument: Instrument,
    pub lab: Lab,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub max_bytes: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewUpload {
    pub upload_id: String,
    pub store_id: String,
    pub part_bytes: u64,
    pub parts: u32,
}

#[derive(Deserialize)]
struct Have {
    have: bool,
}

#[derive(Deserialize)]
struct PartUrl {
    url: String,
}

#[derive(Deserialize)]
struct Ignored {}

pub struct Api {
    agent: Agent,
    server: String,
    token: Option<Token>,
}

impl Api {
    pub fn new(server: &str, token: Option<Token>) -> Self {
        let agent = Agent::config_builder()
            .http_status_as_error(false)
            .max_redirects(0)
            .timeout_connect(Some(Duration::from_secs(30)))
            .timeout_global(Some(Duration::from_secs(15 * 60)))
            .user_agent(concat!("binary-labs-uploader/", env!("CARGO_PKG_VERSION")))
            .build()
            .new_agent();
        Api {
            agent,
            server: server.trim_end_matches('/').to_string(),
            token,
        }
    }

    pub fn pair(&self, code: &str) -> Result<PairReply, Failure> {
        self.post("/api/instruments/pair", &json!({ "code": code }))
    }

    pub fn heartbeat(&self) -> Result<Limits, Failure> {
        self.post("/api/instruments/heartbeat", &json!({}))
    }

    pub fn check(&self, file: &FileInfo) -> Result<bool, Failure> {
        let reply: Have = self.post("/api/instruments/files/check", file)?;
        Ok(reply.have)
    }

    pub fn start_upload(&self, file: &FileInfo) -> Result<NewUpload, Failure> {
        self.post("/api/instruments/uploads", file)
    }

    pub fn part_url(&self, session: &Session, part: u32, size: u64) -> Result<String, Failure> {
        let path = format!(
            "/api/instruments/uploads/{}/parts/{part}",
            session.upload_id
        );
        let reply: PartUrl =
            self.post(&path, &json!({ "storeId": session.store_id, "size": size }))?;
        Ok(reply.url)
    }

    /// PUTs one part and returns its ETag exactly as the store sent it.
    pub fn put_part(&self, url: &str, bytes: &[u8]) -> Result<String, Failure> {
        let response = if url.starts_with('/') {
            self.with_token(self.agent.put(format!("{}{url}", self.server)))
                .send(bytes)
        } else if url.starts_with("https://") || url.starts_with("http://") {
            self.agent.put(url).send(bytes)
        } else {
            return Err(Failure::Rejected {
                status: 0,
                message: "the server gave a part address the uploader doesn't understand".into(),
            });
        };
        let response = response.map_err(unreachable)?;
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            return Err(failure(status, response));
        }
        response
            .headers()
            .get("etag")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
            .ok_or_else(|| Failure::Transient {
                reason: "the store didn't confirm the part (no ETag)".into(),
                retry_after: None,
            })
    }

    pub fn complete(&self, session: &Session, file: &FileInfo) -> Result<(), Failure> {
        let parts: Vec<_> = session
            .etags
            .iter()
            .zip(1..)
            .map(|(etag, n): (&String, u32)| json!({ "partNumber": n, "etag": etag }))
            .collect();
        let body = json!({
            "storeId": session.store_id,
            "path": file.path,
            "sha256": file.sha256,
            "size": file.size,
            "modifiedAt": file.modified_at,
            "parts": parts,
        });
        let path = format!("/api/instruments/uploads/{}/complete", session.upload_id);
        self.post::<Ignored>(&path, &body).map(drop)
    }

    pub fn abort(&self, session: &Session) -> Result<(), Failure> {
        let url = format!(
            "{}/api/instruments/uploads/{}",
            self.server, session.upload_id
        );
        let response = self
            .with_token(self.agent.delete(url))
            .force_send_body()
            .send_json(json!({ "storeId": session.store_id }))
            .map_err(unreachable)?;
        read_reply::<Ignored>(response).map(drop)
    }

    fn post<T: DeserializeOwned>(&self, path: &str, body: &impl Serialize) -> Result<T, Failure> {
        let request = self.agent.post(format!("{}{path}", self.server));
        let response = self
            .with_token(request)
            .send_json(body)
            .map_err(unreachable)?;
        read_reply(response)
    }

    fn with_token<B>(&self, request: ureq::RequestBuilder<B>) -> ureq::RequestBuilder<B> {
        match &self.token {
            Some(token) => request.header("Authorization", token.bearer()),
            None => request,
        }
    }
}

fn read_reply<T: DeserializeOwned>(mut response: Response<Body>) -> Result<T, Failure> {
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(failure(status, response));
    }
    response
        .body_mut()
        .read_json()
        .map_err(|e| Failure::Transient {
            reason: format!("the server sent an answer the uploader couldn't read ({e})"),
            retry_after: None,
        })
}

fn failure(status: u16, mut response: Response<Body>) -> Failure {
    match status {
        401 => Failure::Unpaired,
        413 => Failure::TooLarge,
        429 | 500..=599 => Failure::Transient {
            reason: format!("the server is busy or having trouble ({status})"),
            retry_after: response
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.trim().parse().ok())
                .map(Duration::from_secs),
        },
        _ => Failure::Rejected {
            status,
            message: error_message(&mut response),
        },
    }
}

fn error_message(response: &mut Response<Body>) -> String {
    #[derive(Deserialize)]
    struct ErrorBody {
        error: String,
    }
    response
        .body_mut()
        .read_json::<ErrorBody>()
        .map(|body| body.error)
        .unwrap_or_else(|_| "no reason given".into())
}

fn unreachable(e: ureq::Error) -> Failure {
    Failure::Transient {
        reason: format!("couldn't reach the server ({e})"),
        retry_after: None,
    }
}
