mod common;

use std::path::Path;
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};

use binary_labs_uploader::config::Config;
use binary_labs_uploader::{UNPAIRED_MESSAGE, Uploader};
use common::*;

fn uploader(dir: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_binary-labs-uploader"));
    command.env("BINARY_LABS_UPLOADER_DIR", dir);
    command
}

fn output(command: &mut Command) -> (Output, String) {
    let output = command.output().unwrap();
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    (output, text)
}

fn wait_with_timeout(child: &mut Child, timeout: Duration) -> Option<std::process::ExitStatus> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Some(status) = child.try_wait().unwrap() {
            return Some(status);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    let _ = child.wait();
    None
}

fn logs(dir: &Path) -> String {
    std::fs::read_dir(dir.join("logs"))
        .map(|entries| {
            entries
                .flatten()
                .map(|e| std::fs::read_to_string(e.path()).unwrap_or_default())
                .collect()
        })
        .unwrap_or_default()
}

#[test]
fn pair_saves_a_private_config_and_never_prints_the_token() {
    let mock = Mock::start();
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("Binary").join("uploader");

    let (out, text) = output(uploader(&dir).args(["pair", &mock.url, CODE]));

    assert!(out.status.success(), "{text}");
    assert!(text.contains(INSTRUMENT) && text.contains(LAB), "{text}");
    assert!(!text.contains(TOKEN), "the token was printed: {text}");
    let pair = mock.get().find("POST", "/api/instruments/pair")[0].json();
    assert_eq!(pair, serde_json::json!({ "code": CODE }));
    let config = Config::load(&dir).unwrap();
    assert_eq!(config.instrument.name, INSTRUMENT);
    assert_eq!(config.lab.name, LAB);
    assert_eq!(config.server, mock.url);
    let saved = std::fs::read_to_string(Config::path(&dir)).unwrap();
    assert!(
        saved.contains(TOKEN),
        "the token is stored for later requests"
    );

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&dir), 0o700);
        assert_eq!(mode(&Config::path(&dir)), 0o600);
    }
}

#[test]
fn pair_with_a_bad_code_saves_nothing() {
    let mock = Mock::start();
    mock.get().knobs.pair_ok = false;
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("uploader");

    let (out, text) = output(uploader(&dir).args(["pair", &mock.url, "WRONG-CODE"]));

    assert!(!out.status.success());
    assert!(text.contains("That code didn't work"), "{text}");
    assert!(
        !Config::path(&dir).exists(),
        "no config after a refused code"
    );
}

#[test]
fn add_folder_refuses_duplicates_and_files() {
    let mock = Mock::start();
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("config");
    let exports = tmp.path().join("Exports");
    let other = tmp.path().join("other").join("exports");
    std::fs::create_dir_all(&exports).unwrap();
    std::fs::create_dir_all(&other).unwrap();
    let file = write(tmp.path(), "notes.txt", b"x");
    assert!(
        output(uploader(&dir).args(["pair", &mock.url, CODE]))
            .0
            .status
            .success()
    );

    let (out, text) = output(uploader(&dir).arg("add-folder").arg(&exports));
    assert!(out.status.success(), "{text}");
    assert!(
        text.contains(&format!("Instruments/{INSTRUMENT}/Exports")),
        "{text}"
    );

    let (out, text) = output(uploader(&dir).arg("add-folder").arg(exports.join(".")));
    assert!(
        !out.status.success() && text.contains("Already watching"),
        "{text}"
    );
    let (out, text) = output(uploader(&dir).arg("add-folder").arg(&other));
    assert!(
        !out.status.success() && text.contains("same name"),
        "{text}"
    );
    let (out, text) = output(uploader(&dir).arg("add-folder").arg(&file));
    assert!(
        !out.status.success() && text.contains("not a folder"),
        "{text}"
    );
    let (out, _) = output(
        uploader(&dir)
            .arg("add-folder")
            .arg(tmp.path().join("missing")),
    );
    assert!(!out.status.success());

    let folders = Config::load(&dir).unwrap().folders;
    assert_eq!(folders.len(), 1);
    assert_eq!(folders[0].label, "Exports");
    assert_eq!(folders[0].path, dunce::canonicalize(&exports).unwrap());
}

#[test]
fn run_sends_new_files_it_sees_appear() {
    let mock = Mock::start();
    let (_tmp, dir, folder) = paired(&mock);
    let mut child = uploader(&dir)
        .args(["run", "--settle-secs", "1"])
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    std::thread::sleep(Duration::from_millis(500));
    let bytes = content(2048);
    write(&folder, "new/plate.csv", &bytes);

    let deadline = Instant::now() + Duration::from_secs(20);
    while mock.get().completed.is_empty() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
    }
    let _ = child.kill();
    let _ = child.wait();

    assert_eq!(
        mock.get().completed,
        vec![("Exports/new/plate.csv".to_string(), bytes)]
    );
    assert!(
        !mock
            .get()
            .find("POST", "/api/instruments/heartbeat")
            .is_empty()
    );
    let log = logs(&dir);
    assert!(log.contains("Sent Exports/new/plate.csv"), "{log}");
    assert!(!log.contains(TOKEN), "the token was logged");
}

#[test]
fn a_killed_run_resumes_from_the_last_confirmed_part() {
    let mock = Mock::start();
    mock.get().knobs.stall_part = Some(3);
    let (_tmp, dir, folder) = paired(&mock);
    let bytes = content(4000);
    write(&folder, "big.csv", &bytes);
    let start = || {
        uploader(&dir)
            .args(["run", "--settle-secs", "0"])
            .stdout(Stdio::null())
            .spawn()
            .unwrap()
    };

    let mut first = start();
    let deadline = Instant::now() + Duration::from_secs(20);
    while mock.get().puts() != vec![1, 2, 3] {
        assert!(
            Instant::now() < deadline,
            "never reached part 3: {:?}",
            mock.get().puts()
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    first.kill().unwrap();
    first.wait().unwrap();
    mock.get().knobs.stall_part = None;

    let mut second = start();
    while mock.get().completed.is_empty() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = second.kill();
    let _ = second.wait();

    let inner = mock.get();
    assert_eq!(
        inner.puts(),
        vec![1, 2, 3, 3, 4],
        "parts 1 and 2 are sent once"
    );
    assert_eq!(inner.find("POST", "/api/instruments/uploads").len(), 1);
    assert_eq!(
        inner.completed,
        vec![("Exports/big.csv".to_string(), bytes)]
    );
}

#[test]
fn run_stops_with_a_clear_message_when_unpaired() {
    let mock = Mock::start();
    let (_tmp, dir, _folder) = paired(&mock);
    mock.get().knobs.unauthorized = true;

    let mut child = uploader(&dir)
        .arg("run")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let status =
        wait_with_timeout(&mut child, Duration::from_secs(20)).expect("run exits on a 401");
    let out = child.wait_with_output().unwrap();
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );

    assert!(!status.success());
    assert!(
        String::from_utf8_lossy(&out.stderr).contains(UNPAIRED_MESSAGE),
        "{text}"
    );
    assert!(!text.contains(TOKEN));
    assert!(!logs(&dir).contains(TOKEN));
}

#[test]
fn status_shows_folders_queue_and_sent_files() {
    let mock = Mock::start();
    let (_tmp, dir, folder) = paired(&mock);
    write(&folder, "done.csv", &content(300));
    let mut engine = Uploader::open(&dir, fast()).unwrap();
    engine.scan();
    drain(&mut engine);
    write(&folder, "next.csv", &content(300));
    engine.scan();
    engine.flush();

    let (out, text) = output(uploader(&dir).arg("status"));

    assert!(out.status.success(), "{text}");
    for expected in [
        format!("Server: {}", mock.url),
        format!("Instrument: {INSTRUMENT} in {LAB}"),
        format!("Exports ({})", folder.display()),
        "Queue: 1 file".to_string(),
        "Exports/next.csv: waiting for the file to be still".to_string(),
        "Files sent: 1".to_string(),
        "Last sync: just now".to_string(),
        "Last error: none".to_string(),
    ] {
        assert!(text.contains(&expected), "missing {expected:?} in:\n{text}");
    }
    assert!(!text.contains(TOKEN));
}
