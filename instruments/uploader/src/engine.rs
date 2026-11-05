use std::fmt;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tracing::{error, info, warn};

use crate::api::{Api, Failure, FileInfo};
use crate::config::{Config, Folder};
use crate::files::{self, Stat};
use crate::state::{Item, LastError, Phase, SentFile, Session, State, Work};

pub const UNPAIRED_MESSAGE: &str =
    "This uploader isn't paired any more. Ask your lab admin for a new code and run pair again.";

/// Throttles queue writes that a crash could lose without harm: a rescan or a `check` recovers them.
const SAVE_EVERY: Duration = Duration::from_secs(5);

#[derive(Debug)]
pub struct Unpaired;

impl fmt::Display for Unpaired {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(UNPAIRED_MESSAGE)
    }
}

impl std::error::Error for Unpaired {}

#[derive(Clone, Debug)]
pub struct Options {
    /// How long size and modified time must hold still before a file is sent.
    pub settle: Duration,
    /// Wait before retry n; the last entry repeats.
    pub retry_delays: Vec<Duration>,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            settle: Duration::from_secs(10),
            retry_delays: [2, 5, 15, 30, 60, 120, 240, 300]
                .map(Duration::from_secs)
                .to_vec(),
        }
    }
}

enum Next {
    Phase(Phase),
    /// A confirmed part with more to go: saved at once so a restart doesn't send it again.
    Durable(Phase),
    Sent {
        sha256: String,
    },
}

pub struct Uploader {
    dir: PathBuf,
    config: Config,
    api: Api,
    state: State,
    options: Options,
    max_bytes: Option<u64>,
    dirty: bool,
    saved_at: Instant,
}

impl Uploader {
    pub fn open(dir: &Path, options: Options) -> anyhow::Result<Uploader> {
        let config = Config::load(dir)?;
        let state = State::load(dir)?
            .filter(|s| s.instrument_id == config.instrument.id)
            .unwrap_or_else(|| State::new(&config.instrument.id));
        Ok(Uploader {
            dir: dir.to_path_buf(),
            api: Api::new(&config.server, Some(config.token.clone())),
            config,
            state,
            options,
            max_bytes: None,
            dirty: false,
            saved_at: Instant::now(),
        })
    }

    pub fn config(&self) -> &Config {
        &self.config
    }

    pub fn state(&self) -> &State {
        &self.state
    }

    /// Picks up folders added and re-pairing done while `run` is running.
    pub fn reload_config(&mut self) -> anyhow::Result<()> {
        let config = Config::load(&self.dir)?;
        if config.instrument.id != self.config.instrument.id {
            info!(
                "Paired as {} now; starting over for it",
                config.instrument.name
            );
            self.state = State::new(&config.instrument.id);
            self.dirty = true;
        }
        self.api = Api::new(&config.server, Some(config.token.clone()));
        self.config = config;
        Ok(())
    }

    pub fn heartbeat(&mut self) -> Result<(), Unpaired> {
        match self.api.heartbeat() {
            Ok(limits) => {
                self.max_bytes = Some(limits.max_bytes);
                Ok(())
            }
            Err(Failure::Unpaired) => self.stop(),
            Err(failure) => {
                warn!("Heartbeat failed: {failure}");
                self.note_error(format!("Heartbeat failed: {failure}"));
                Ok(())
            }
        }
    }

    pub fn scan(&mut self) {
        let now = now_ms();
        for folder in self.config.folders.clone() {
            files::walk(&folder.path, &mut |file, stat| {
                self.consider(&folder, file, stat, now)
            });
        }
        let before = self.state.queue.len();
        self.state
            .queue
            .retain(|file, item| item.phase != Phase::TooLarge || file.exists());
        self.dirty |= before != self.state.queue.len();
    }

    /// Handles a path reported by the folder watcher. A folder is walked only when `appeared`,
    /// since Windows also reports a folder as modified whenever a file inside it changes.
    pub fn notice(&mut self, path: &Path, appeared: bool) {
        let Some(folder) = self
            .config
            .folders
            .iter()
            .find(|f| path.starts_with(&f.path))
            .cloned()
        else {
            return;
        };
        if files::is_skipped_path(&folder.path, path) {
            return;
        }
        let now = now_ms();
        match std::fs::symlink_metadata(path) {
            Ok(meta) if meta.is_dir() && appeared => files::walk(path, &mut |file, stat| {
                self.consider(&folder, file, stat, now)
            }),
            Ok(meta) if meta.is_file() => {
                self.consider(&folder, path.to_path_buf(), Stat::of(&meta), now)
            }
            _ => {}
        }
    }

    /// Does the next piece of work: one hash, one server check, one part or one completion.
    /// Returns false when nothing is due yet.
    pub fn step(&mut self) -> Result<bool, Unpaired> {
        let now = now_ms();
        self.settle(now);
        let Some(file) = self.next_due(now) else {
            self.save_if_due();
            return Ok(false);
        };
        let item = self
            .state
            .queue
            .remove(&file)
            .expect("a due file is queued");
        self.dirty = true;
        match self.advance(&file, item, now) {
            Ok((Some(item), durable)) => {
                self.state.queue.insert(file, item);
                if durable {
                    self.save();
                } else {
                    self.save_if_due();
                }
            }
            Ok((None, _)) => self.save_if_due(),
            Err(item) => {
                self.state.queue.insert(file, *item);
                return self.stop();
            }
        }
        Ok(true)
    }

    pub fn flush(&mut self) {
        if self.dirty {
            self.save();
        }
    }

    fn stop<T>(&mut self) -> Result<T, Unpaired> {
        error!("{UNPAIRED_MESSAGE}");
        self.note_error(UNPAIRED_MESSAGE.to_string());
        self.save();
        Err(Unpaired)
    }

    fn consider(&mut self, folder: &Folder, file: PathBuf, stat: Stat, now: u64) {
        let Some(path) = files::sent_path(folder, &file) else {
            warn!(
                "Skipping {} (its path is too long or has unusual characters)",
                file.display()
            );
            return;
        };
        let settling = Phase::Settling { seen_at: now };
        match self.state.queue.get_mut(&file) {
            Some(item) if item.phase == Phase::TooLarge && item.stat != stat => {
                item.stat = stat;
                item.phase = settling;
                self.dirty = true;
            }
            Some(_) => {}
            None => {
                if self.state.sent.get(&path).is_some_and(|s| s.stat == stat) {
                    return;
                }
                let item = Item {
                    path,
                    stat,
                    phase: settling,
                };
                self.state.queue.insert(file, item);
                self.dirty = true;
            }
        }
    }

    /// Moves files whose size and modified time held still for the settle time, and which no
    /// other program is writing, on to hashing.
    fn settle(&mut self, now: u64) {
        let settle_ms = self.options.settle.as_millis() as u64;
        let max_bytes = self.max_bytes;
        let mut changed = false;
        self.state.queue.retain(|file, item| {
            let Phase::Settling { seen_at } = item.phase else {
                return true;
            };
            if now < seen_at + settle_ms {
                return true;
            }
            changed = true;
            match files::stat(file) {
                Err(e) if e.kind() == io::ErrorKind::NotFound => return false,
                Err(_) => item.phase = Phase::Settling { seen_at: now },
                Ok(stat) if stat != item.stat => {
                    item.stat = stat;
                    item.phase = Phase::Settling { seen_at: now };
                }
                Ok(stat) if max_bytes.is_some_and(|max| stat.size > max) => {
                    info!("{} is too large to send", item.path);
                    item.phase = Phase::TooLarge;
                }
                Ok(_) if !files::is_free(file) => item.phase = Phase::Settling { seen_at: now },
                Ok(_) => item.phase = Phase::Work(Work::Hash),
            }
            true
        });
        self.dirty |= changed;
    }

    /// An upload in progress goes first, so one file finishes before the next one starts.
    fn next_due(&self, now: u64) -> Option<PathBuf> {
        let mut first = None;
        for (file, item) in &self.state.queue {
            let work = match &item.phase {
                Phase::Work(work) => work,
                Phase::RetryAfter { at, then, .. } if *at <= now => then,
                _ => continue,
            };
            if matches!(work, Work::Upload { .. }) {
                return Some(file.clone());
            }
            first.get_or_insert(file);
        }
        first.cloned()
    }

    /// Returns the item's new state (None once it's sent or gone) and whether to save at once.
    /// On a 401 it returns the item unchanged as the error.
    fn advance(
        &mut self,
        file: &Path,
        item: Item,
        now: u64,
    ) -> Result<(Option<Item>, bool), Box<Item>> {
        let Item { path, stat, phase } = item;
        let (work, attempt) = match phase {
            Phase::Work(work) => (work, 0),
            Phase::RetryAfter { then, attempt, .. } => (then, attempt),
            phase => return Ok((Some(Item { path, stat, phase }), false)),
        };
        let current = match files::stat(file) {
            Ok(current) => Some(current),
            Err(e) if e.kind() == io::ErrorKind::NotFound => None,
            Err(e) => {
                let item = self.retry(path, stat, work, attempt, e.into(), now);
                return Ok((Some(item), false));
            }
        };
        if current != Some(stat) {
            if let Work::Upload { session, .. } = &work {
                self.abort(session).map_err(|Unpaired| {
                    Box::new(Item {
                        path: path.clone(),
                        stat,
                        phase: Phase::Work(work.clone()),
                    })
                })?;
            }
            info!("{path} changed; waiting for it to be still again");
            let item = current.map(|stat| Item {
                path,
                stat,
                phase: Phase::Settling { seen_at: now },
            });
            return Ok((item, false));
        }
        match self.act(file, &path, stat, &work) {
            Ok(Next::Phase(phase)) => Ok((Some(Item { path, stat, phase }), false)),
            Ok(Next::Durable(phase)) => Ok((Some(Item { path, stat, phase }), true)),
            Ok(Next::Sent { sha256 }) => {
                self.state.sent.insert(path, SentFile { stat, sha256 });
                self.state.last_sync = Some(now_ms());
                Ok((None, false))
            }
            Err(Failure::Unpaired) => Err(Box::new(Item {
                path,
                stat,
                phase: Phase::Work(work),
            })),
            Err(Failure::TooLarge) => {
                info!("{path} is too large to send");
                let phase = Phase::TooLarge;
                Ok((Some(Item { path, stat, phase }), false))
            }
            Err(failure) => Ok((
                Some(self.retry(path, stat, work, attempt, failure, now)),
                false,
            )),
        }
    }

    fn act(&mut self, file: &Path, path: &str, stat: Stat, work: &Work) -> Result<Next, Failure> {
        match work {
            Work::Hash => self.hash(file, stat),
            Work::Check { sha256 } => self.check(path, stat, sha256),
            Work::Upload { sha256, session } => self.send(file, path, stat, sha256, session),
        }
    }

    fn hash(&self, file: &Path, stat: Stat) -> Result<Next, Failure> {
        if self.max_bytes.is_some_and(|max| stat.size > max) {
            return Err(Failure::TooLarge);
        }
        let sha256 = files::sha256(file)?;
        if files::stat(file)? != stat {
            return Ok(Next::Phase(Phase::Settling { seen_at: now_ms() }));
        }
        Ok(Next::Phase(Phase::Work(Work::Check { sha256 })))
    }

    fn check(&self, path: &str, stat: Stat, sha256: &str) -> Result<Next, Failure> {
        let info = file_info(path, stat, sha256);
        if self.api.check(&info)? {
            info!("{path} is already in the lab");
            return Ok(Next::Sent {
                sha256: sha256.to_string(),
            });
        }
        let upload = self.api.start_upload(&info)?;
        if upload.part_bytes == 0 || u64::from(upload.parts) * upload.part_bytes < stat.size {
            return Err(Failure::Rejected {
                status: 200,
                message: "the server's part sizes don't cover the file".into(),
            });
        }
        let session = Session {
            upload_id: upload.upload_id,
            store_id: upload.store_id,
            part_bytes: upload.part_bytes,
            parts: upload.parts,
            etags: Vec::new(),
        };
        let sha256 = sha256.to_string();
        Ok(Next::Phase(Phase::Work(Work::Upload { sha256, session })))
    }

    fn send(
        &self,
        file: &Path,
        path: &str,
        stat: Stat,
        sha256: &str,
        session: &Session,
    ) -> Result<Next, Failure> {
        let Some(part) = session.next_part() else {
            return self.complete(path, stat, sha256, session);
        };
        let url = self.api.part_url(session, part, stat.size)?;
        let (start, len) = session.range(part, stat.size);
        let bytes = files::read_part(file, start, len)?;
        let etag = self.api.put_part(&url, &bytes)?;
        let mut session = session.clone();
        session.etags.push(etag);
        let more = session.next_part().is_some();
        let sha256 = sha256.to_string();
        let phase = Phase::Work(Work::Upload { sha256, session });
        Ok(if more {
            Next::Durable(phase)
        } else {
            Next::Phase(phase)
        })
    }

    fn complete(
        &self,
        path: &str,
        stat: Stat,
        sha256: &str,
        session: &Session,
    ) -> Result<Next, Failure> {
        match self.api.complete(session, &file_info(path, stat, sha256)) {
            Ok(()) => {
                info!("Sent {path}");
                Ok(Next::Sent {
                    sha256: sha256.to_string(),
                })
            }
            Err(Failure::Rejected {
                status: 400 | 409 | 422,
                message,
            }) => {
                warn!(
                    "The server didn't accept {path} ({message}); sending it again from the start"
                );
                Ok(Next::Phase(Phase::Work(Work::Hash)))
            }
            Err(failure) => Err(failure),
        }
    }

    /// Drops a stale upload session on the server. Only a 401 matters to the caller.
    fn abort(&self, session: &Session) -> Result<(), Unpaired> {
        match self.api.abort(session) {
            Ok(()) => Ok(()),
            Err(Failure::Unpaired) => Err(Unpaired),
            Err(failure) => {
                warn!("Couldn't cancel an unfinished upload: {failure}");
                Ok(())
            }
        }
    }

    fn retry(
        &mut self,
        path: String,
        stat: Stat,
        work: Work,
        attempt: u32,
        failure: Failure,
        now: u64,
    ) -> Item {
        let delays = &self.options.retry_delays;
        let mut delay = delays
            .get(attempt as usize)
            .or(delays.last())
            .copied()
            .unwrap_or_default();
        if let Failure::Transient {
            retry_after: Some(after),
            ..
        } = failure
        {
            delay = delay.max(after);
        }
        warn!("{path}: {failure}. Trying again in {} s", delay.as_secs());
        self.note_error(format!("{path}: {failure}"));
        Item {
            path,
            stat,
            phase: Phase::RetryAfter {
                at: now + delay.as_millis() as u64,
                attempt: attempt + 1,
                reason: failure.to_string(),
                then: work,
            },
        }
    }

    fn note_error(&mut self, message: String) {
        self.state.last_error = Some(LastError {
            at: now_ms(),
            message,
        });
        self.dirty = true;
    }

    fn save_if_due(&mut self) {
        if self.dirty && self.saved_at.elapsed() >= SAVE_EVERY {
            self.save();
        }
    }

    fn save(&mut self) {
        match self.state.save(&self.dir) {
            Ok(()) => {
                self.dirty = false;
                self.saved_at = Instant::now();
            }
            Err(e) => error!("Couldn't save the upload queue: {e:#}"),
        }
    }
}

fn file_info<'a>(path: &'a str, stat: Stat, sha256: &'a str) -> FileInfo<'a> {
    FileInfo {
        path,
        sha256,
        size: stat.size,
        modified_at: stat.modified_at,
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}
