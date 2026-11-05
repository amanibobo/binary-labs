use std::path::Path;

use anyhow::{Context, anyhow, bail};

use crate::api::{Api, Failure};
use crate::config::{Config, Folder};

/// Trades a pairing code for a device token and saves it. Nothing is written unless pairing works.
pub fn pair(dir: &Path, server: &str, code: &str) -> anyhow::Result<Config> {
    let server = server.trim().trim_end_matches('/');
    if !(server.starts_with("https://") || server.starts_with("http://")) {
        bail!("The server address should start with https://, like https://app.binarylabs.example");
    }
    let reply = Api::new(server, None)
        .pair(code)
        .map_err(|failure| match failure {
            Failure::Unpaired => anyhow!(
                "That code didn't work. A code works once and only for 15 minutes. \
             Get a new one in Settings > Instruments and try again."
            ),
            Failure::Transient {
                retry_after: Some(after),
                ..
            } => anyhow!(
                "Too many tries. Wait {} seconds and try again.",
                after.as_secs()
            ),
            failure => anyhow!("Couldn't pair with {server}: {failure}."),
        })?;
    let folders = Config::load_if_paired(dir)?
        .map(|old| old.folders)
        .unwrap_or_default();
    let config = Config {
        server: server.to_string(),
        token: reply.token,
        instrument: reply.instrument,
        lab: reply.lab,
        folders,
    };
    config.save(dir)?;
    Ok(config)
}

pub fn add_folder(dir: &Path, path: &Path) -> anyhow::Result<Folder> {
    let mut config = Config::load(dir)?;
    let path = dunce::canonicalize(path)
        .with_context(|| format!("Can't find the folder {}", path.display()))?;
    if !path.is_dir() {
        bail!("{} is a file, not a folder.", path.display());
    }
    let label = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| anyhow!("Pick a folder on the drive, not the whole drive."))?
        .to_string();
    if config.folders.iter().any(|f| f.path == path) {
        bail!("Already watching {}.", path.display());
    }
    if let Some(same) = config
        .folders
        .iter()
        .find(|f| f.label.eq_ignore_ascii_case(&label))
    {
        bail!(
            "Already watching a folder named {label} at {}. Two folders with the same name \
             would mix their files in Binary. Rename one of them, or watch their parent folder.",
            same.path.display()
        );
    }
    let folder = Folder { path, label };
    config.folders.push(folder.clone());
    config.save(dir)?;
    Ok(folder)
}
