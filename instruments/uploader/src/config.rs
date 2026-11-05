use std::fmt;
use std::path::{Path, PathBuf};

use anyhow::Context;
use serde::{Deserialize, Serialize};

use crate::store;

pub const NOT_PAIRED: &str =
    "This uploader isn't paired yet. Run pair with the code from Settings > Instruments first.";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub server: String,
    pub token: Token,
    pub instrument: Instrument,
    pub lab: Lab,
    #[serde(default)]
    pub folders: Vec<Folder>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Instrument {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Lab {
    pub name: String,
}

/// A watched folder. Files in it are sent as `<label>/<path inside it>`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Folder {
    pub path: PathBuf,
    pub label: String,
}

/// The device token. It has no `Display` and its `Debug` hides it, so it can't reach a log line.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Token(String);

impl Token {
    pub fn bearer(&self) -> String {
        format!("Bearer {}", self.0)
    }
}

impl fmt::Debug for Token {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Token(hidden)")
    }
}

impl Config {
    pub fn path(dir: &Path) -> PathBuf {
        dir.join("config.json")
    }

    pub fn load(dir: &Path) -> anyhow::Result<Config> {
        Self::load_if_paired(dir)?.context(NOT_PAIRED)
    }

    pub fn load_if_paired(dir: &Path) -> anyhow::Result<Option<Config>> {
        store::read_json(&Self::path(dir))
    }

    pub fn save(&self, dir: &Path) -> anyhow::Result<()> {
        store::private_dir(dir).with_context(|| format!("Couldn't create {}", dir.display()))?;
        let bytes = serde_json::to_vec_pretty(self)?;
        store::write_private(&Self::path(dir), &bytes)
            .with_context(|| format!("Couldn't save the settings in {}", dir.display()))
    }
}

pub fn default_dir() -> Option<PathBuf> {
    dirs::config_local_dir().map(|base| base.join("Binary").join("uploader"))
}
