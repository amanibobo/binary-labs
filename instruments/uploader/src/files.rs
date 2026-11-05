use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tracing::warn;

use crate::config::Folder;

const MAX_SENT_PATH_CHARS: usize = 1000;
const HASH_BUFFER_BYTES: usize = 64 * 1024;

/// What the uploader compares to decide a file changed: its size and modified time in epoch ms.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stat {
    pub size: u64,
    pub modified_at: i64,
}

impl Stat {
    pub fn of(meta: &Metadata) -> Stat {
        let modified_at = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_millis() as i64);
        Stat {
            size: meta.len(),
            modified_at,
        }
    }
}

pub fn stat(path: &Path) -> io::Result<Stat> {
    fs::metadata(path).map(|m| Stat::of(&m))
}

pub fn is_skipped_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    name.starts_with("~$")
        || name.starts_with('.')
        || lower.ends_with(".tmp")
        || lower.ends_with(".lock")
        || lower == "thumbs.db"
        || lower == "desktop.ini"
}

#[cfg(windows)]
fn is_hidden(meta: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
    const FILE_ATTRIBUTE_SYSTEM: u32 = 0x4;
    meta.file_attributes() & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM) != 0
}

#[cfg(not(windows))]
fn is_hidden(_meta: &Metadata) -> bool {
    false
}

fn is_skipped(name: &str, meta: &Metadata) -> bool {
    is_skipped_name(name) || is_hidden(meta) || meta.file_type().is_symlink()
}

/// True when `path` or any folder between it and `root` is a temp, lock or hidden entry.
pub fn is_skipped_path(root: &Path, path: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(root) else {
        return true;
    };
    let mut current = root.to_path_buf();
    for component in rel.components() {
        let Component::Normal(name) = component else {
            return true;
        };
        current.push(name);
        let Some(name) = name.to_str() else {
            return true;
        };
        if is_skipped_name(name) {
            return true;
        }
        if let Ok(meta) = fs::symlink_metadata(&current)
            && (is_hidden(&meta) || meta.file_type().is_symlink())
        {
            return true;
        }
    }
    false
}

/// Calls `found` for every file under `dir`, skipping temp, lock, hidden and linked entries.
pub fn walk(dir: &Path, found: &mut dyn FnMut(PathBuf, Stat)) {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) => {
            warn!("Couldn't list {}: {e}", dir.display());
            return;
        }
    };
    for entry in entries.flatten() {
        let Ok(meta) = fs::symlink_metadata(entry.path()) else {
            continue;
        };
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            warn!(
                "Skipping {} (its name isn't valid Unicode)",
                entry.path().display()
            );
            continue;
        };
        if is_skipped(name, &meta) {
            continue;
        }
        if meta.is_dir() {
            walk(&entry.path(), found);
        } else if meta.is_file() {
            found(entry.path(), Stat::of(&meta));
        }
    }
}

/// The path the lab sees: `<folder label>/<path inside the folder>` with forward slashes.
pub fn sent_path(folder: &Folder, file: &Path) -> Option<String> {
    let rel = file.strip_prefix(&folder.path).ok()?;
    let mut parts = vec![folder.label.as_str()];
    for component in rel.components() {
        match component {
            Component::Normal(name) => parts.push(name.to_str()?),
            _ => return None,
        }
    }
    let path = parts.join("/");
    (parts.len() > 1 && path.chars().count() <= MAX_SENT_PATH_CHARS).then_some(path)
}

/// Whether the file can be opened for reading while denying writers. On Windows this fails with
/// a sharing violation while the instrument still has the file open for writing.
pub fn is_free(path: &Path) -> bool {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_READ: u32 = 0x1;
        options.share_mode(FILE_SHARE_READ);
    }
    options.open(path).is_ok()
}

/// Opens for reading only. Long reads keep the default sharing, so the instrument is never
/// locked out of its own file while the uploader hashes or sends it.
fn open_read(path: &Path) -> io::Result<File> {
    OpenOptions::new().read(true).open(path)
}

pub fn sha256(path: &Path) -> io::Result<String> {
    let mut file = open_read(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0; HASH_BUFFER_BYTES];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

pub fn read_part(path: &Path, start: u64, len: u64) -> io::Result<Vec<u8>> {
    let mut file = open_read(path)?;
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = vec![0; len as usize];
    file.read_exact(&mut bytes)?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skips_temp_lock_and_hidden_names() {
        for name in [
            "~$plate.xlsx",
            ".DS_Store",
            "run.tmp",
            "RUN.TMP",
            "db.Lock",
            "Thumbs.db",
            "desktop.ini",
        ] {
            assert!(is_skipped_name(name), "{name} should be skipped");
        }
        for name in ["plate07.csv", "tmp.csv", "lock-notes.txt", "a~$b.txt"] {
            assert!(!is_skipped_name(name), "{name} should be sent");
        }
    }

    #[test]
    fn sent_path_is_label_then_relative_path() {
        let folder = Folder {
            path: PathBuf::from("/data/Exports"),
            label: "Exports".into(),
        };
        assert_eq!(
            sent_path(&folder, Path::new("/data/Exports/P450/plate07.csv")).as_deref(),
            Some("Exports/P450/plate07.csv")
        );
        assert_eq!(sent_path(&folder, Path::new("/data/Exports")), None);
        assert_eq!(sent_path(&folder, Path::new("/data/Other/a.csv")), None);
        let long = format!("/data/Exports/{}", "a".repeat(1000));
        assert_eq!(sent_path(&folder, Path::new(&long)), None);
    }
}
