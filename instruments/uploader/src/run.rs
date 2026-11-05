use std::collections::HashSet;
use std::fs::{File, OpenOptions, TryLockError};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use anyhow::{Context, bail};
use notify::event::ModifyKind;
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tracing::{info, warn};

use crate::engine::{Options, Uploader};

const HEARTBEAT_EVERY: Duration = Duration::from_secs(60);
const IDLE_WAIT: Duration = Duration::from_millis(500);

type Events = Receiver<notify::Result<notify::Event>>;

/// Watches and sends until the uploader is unpaired. Transient errors never end it.
pub fn run(dir: &Path, options: Options, rescan_every: Duration) -> anyhow::Result<()> {
    let _lock = lock(dir)?;
    let mut uploader = Uploader::open(dir, options)?;
    let (tx, events) = mpsc::channel();
    let mut watcher = notify::recommended_watcher(tx).context("Couldn't start watching folders")?;
    let mut watched = HashSet::new();
    watch(&mut watcher, &uploader, &mut watched);
    info!(
        "Sending files from {} to {}",
        uploader.config().instrument.name,
        uploader.config().lab.name
    );

    uploader.heartbeat()?;
    uploader.scan();
    let mut next_heartbeat = Instant::now() + HEARTBEAT_EVERY;
    let mut next_scan = Instant::now() + rescan_every;
    loop {
        let worked = uploader.step()?;
        drain(
            &events,
            &mut uploader,
            if worked { Duration::ZERO } else { IDLE_WAIT },
        );
        let now = Instant::now();
        if now >= next_heartbeat {
            next_heartbeat = now + HEARTBEAT_EVERY;
            if let Err(e) = uploader.reload_config() {
                warn!("Couldn't reload the settings: {e:#}");
            }
            watch(&mut watcher, &uploader, &mut watched);
            uploader.heartbeat()?;
        }
        if now >= next_scan {
            next_scan = now + rescan_every;
            uploader.scan();
        }
    }
}

fn drain(events: &Events, uploader: &mut Uploader, wait: Duration) {
    let mut next = events.recv_timeout(wait);
    loop {
        match next {
            Ok(Ok(event)) if event.need_rescan() => uploader.scan(),
            Ok(Ok(event)) => {
                let appeared = matches!(
                    event.kind,
                    EventKind::Create(_) | EventKind::Modify(ModifyKind::Name(_))
                );
                for path in &event.paths {
                    uploader.notice(path, appeared);
                }
            }
            Ok(Err(e)) => {
                warn!("The folder watcher reported a problem ({e}); rescanning");
                uploader.scan();
            }
            Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => return,
        }
        next = events.try_recv().map_err(|_| RecvTimeoutError::Timeout);
    }
}

/// Watches folders not watched yet, so one that was missing at start is picked up later.
fn watch(watcher: &mut RecommendedWatcher, uploader: &Uploader, watched: &mut HashSet<PathBuf>) {
    for folder in &uploader.config().folders {
        if watched.contains(&folder.path) {
            continue;
        }
        match watcher.watch(&folder.path, RecursiveMode::Recursive) {
            Ok(()) => {
                info!("Watching {}", folder.path.display());
                watched.insert(folder.path.clone());
            }
            Err(e) => warn!(
                "Can't watch {} yet ({e}); the regular rescan still covers it",
                folder.path.display()
            ),
        }
    }
}

fn lock(dir: &Path) -> anyhow::Result<File> {
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join("run.lock"))
        .with_context(|| format!("Couldn't open the lock file in {}", dir.display()))?;
    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(TryLockError::WouldBlock) => {
            bail!("The uploader is already running for {}.", dir.display())
        }
        Err(TryLockError::Error(e)) => Err(e).context("Couldn't lock the settings folder"),
    }
}
