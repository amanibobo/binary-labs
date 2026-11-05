use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::files::Stat;
use crate::store;

/// Everything `run` remembers between restarts. Only `run` writes it; `status` reads it.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub instrument_id: String,
    /// Files that need something done, keyed by absolute path.
    pub queue: BTreeMap<PathBuf, Item>,
    /// Files the lab has, keyed by sent path, so an unchanged file is never read again.
    pub sent: BTreeMap<String, SentFile>,
    pub last_sync: Option<u64>,
    pub last_error: Option<LastError>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub path: String,
    pub stat: Stat,
    pub phase: Phase,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Phase {
    /// Waiting for size and modified time to hold still since `seen_at` (epoch ms).
    Settling {
        seen_at: u64,
    },
    Work(Work),
    RetryAfter {
        at: u64,
        attempt: u32,
        reason: String,
        then: Work,
    },
    TooLarge,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Work {
    Hash,
    Check { sha256: String },
    Upload { sha256: String, session: Session },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub upload_id: String,
    pub store_id: String,
    pub part_bytes: u64,
    pub parts: u32,
    /// ETags of the confirmed parts, in order: `etags[n - 1]` is part n's.
    pub etags: Vec<String>,
}

impl Session {
    pub fn next_part(&self) -> Option<u32> {
        let next = self.etags.len() as u32 + 1;
        (next <= self.parts).then_some(next)
    }

    /// Part n covers bytes [(n-1)*partBytes, min(size, n*partBytes)).
    pub fn range(&self, part: u32, size: u64) -> (u64, u64) {
        let start = u64::from(part - 1) * self.part_bytes;
        let end = (start + self.part_bytes).min(size);
        (start, end.saturating_sub(start))
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SentFile {
    #[serde(flatten)]
    pub stat: Stat,
    pub sha256: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastError {
    pub at: u64,
    pub message: String,
}

impl State {
    pub fn new(instrument_id: &str) -> State {
        State {
            instrument_id: instrument_id.to_string(),
            ..State::default()
        }
    }

    pub fn path(dir: &Path) -> PathBuf {
        dir.join("state.json")
    }

    pub fn load(dir: &Path) -> anyhow::Result<Option<State>> {
        store::read_json(&Self::path(dir))
    }

    pub fn save(&self, dir: &Path) -> anyhow::Result<()> {
        let bytes = serde_json::to_vec(self)?;
        store::write_private(&Self::path(dir), &bytes)?;
        Ok(())
    }
}
