mod common;

use std::fs::OpenOptions;
use std::io::Write;
use std::time::{Duration, Instant};

use binary_labs_uploader::config::Config;
use binary_labs_uploader::state::{Phase, State};
use binary_labs_uploader::{Options, Uploader, status};
use common::*;
use serde_json::json;

const UPLOADS: &str = "/api/instruments/uploads";

fn open(dir: &std::path::Path, options: Options) -> Uploader {
    Uploader::open(dir, options).unwrap()
}

fn step_until(uploader: &mut Uploader, mut done: impl FnMut() -> bool) {
    for _ in 0..1000 {
        if done() {
            return;
        }
        uploader.step().unwrap();
    }
    panic!("condition never held");
}

#[test]
fn have_true_sends_nothing_and_is_not_read_again() {
    let mock = Mock::start();
    mock.get()
        .knobs
        .have
        .insert("Exports/P450/plate07.csv".into());
    let (_tmp, dir, folder) = paired(&mock);
    let bytes = content(2000);
    let file = write(&folder, "P450/plate07.csv", &bytes);

    let mut uploader = open(&dir, fast());
    uploader.scan();
    drain(&mut uploader);
    uploader.flush();

    {
        let inner = mock.get();
        let checks = inner.checks();
        assert_eq!(checks.len(), 1);
        assert_eq!(checks[0]["path"], "Exports/P450/plate07.csv");
        assert_eq!(checks[0]["sha256"], sha_hex(&bytes));
        assert_eq!(checks[0]["size"], 2000);
        let modified = std::fs::metadata(&file).unwrap().modified().unwrap();
        let ms = modified
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        assert_eq!(checks[0]["modifiedAt"], ms);
        assert!(
            inner.with_prefix("POST", UPLOADS).is_empty(),
            "nothing uploaded"
        );
        assert!(inner.puts().is_empty(), "no parts sent");
    }
    assert!(
        uploader
            .state()
            .sent
            .contains_key("Exports/P450/plate07.csv")
    );

    let mut restarted = open(&dir, fast());
    restarted.scan();
    drain(&mut restarted);
    assert_eq!(
        mock.get().checks().len(),
        1,
        "an unchanged file isn't checked again after a restart"
    );
}

#[test]
fn multipart_upload_sends_every_part_and_completes() {
    let mock = Mock::start();
    let (_tmp, dir, folder) = paired(&mock);
    let bytes = content(3500);
    write(&folder, "plate.csv", &bytes);

    let mut uploader = open(&dir, fast());
    uploader.scan();
    drain(&mut uploader);

    let inner = mock.get();
    assert_eq!(inner.puts(), vec![1, 2, 3, 4]);
    let bodies: Vec<&[u8]> = inner
        .requests
        .iter()
        .filter(|r| r.method == "PUT")
        .map(|r| r.body.as_slice())
        .collect();
    assert_eq!(bodies, bytes.chunks(1024).collect::<Vec<_>>());

    let completes = inner.with_prefix("POST", "/api/instruments/uploads/up-1/complete");
    assert_eq!(completes.len(), 1);
    let body = completes[0].json();
    assert_eq!(body["sha256"], sha_hex(&bytes));
    assert_eq!(body["size"], 3500);
    assert_eq!(body["storeId"], "store-1");
    assert_eq!(body["path"], "Exports/plate.csv");
    let expected_parts: Vec<_> = bytes
        .chunks(1024)
        .enumerate()
        .map(|(i, chunk)| {
            let etag = format!("\"{}-{}\"", i + 1, &sha_hex(chunk)[..12]);
            json!({ "partNumber": i + 1, "etag": etag })
        })
        .collect();
    assert_eq!(
        body["parts"],
        json!(expected_parts),
        "ETags sent back exactly, quotes included"
    );
    assert_eq!(
        inner.completed,
        vec![("Exports/plate.csv".to_string(), bytes)]
    );
}

#[test]
fn restart_sends_only_the_parts_not_confirmed_yet() {
    let mock = Mock::start();
    let (_tmp, dir, folder) = paired(&mock);
    let bytes = content(4000);
    write(&folder, "run1.csv", &bytes);

    let mut uploader = open(&dir, fast());
    uploader.scan();
    step_until(&mut uploader, || mock.get().puts().len() == 2);
    drop(uploader);

    let mut restarted = open(&dir, fast());
    restarted.scan();
    drain(&mut restarted);

    let inner = mock.get();
    assert_eq!(
        inner.puts(),
        vec![1, 2, 3, 4],
        "parts 1 and 2 are not sent again"
    );
    assert_eq!(
        inner.find("POST", UPLOADS).len(),
        1,
        "the same upload session is resumed"
    );
    assert_eq!(
        inner.completed,
        vec![("Exports/run1.csv".to_string(), bytes)]
    );
}

#[test]
fn a_failed_part_is_retried_without_resending_earlier_parts() {
    let mock = Mock::start();
    mock.get().knobs.fail_puts = vec![3];
    let (_tmp, dir, folder) = paired(&mock);
    let bytes = content(4000);
    write(&folder, "run2.csv", &bytes);

    let mut uploader = open(&dir, fast());
    uploader.scan();
    drain(&mut uploader);

    let inner = mock.get();
    assert_eq!(inner.puts(), vec![1, 2, 3, 3, 4]);
    assert_eq!(
        inner.completed,
        vec![("Exports/run2.csv".to_string(), bytes)]
    );
    let error = uploader
        .state()
        .last_error
        .as_ref()
        .expect("the failure is recorded");
    assert!(
        error.message.contains("Exports/run2.csv"),
        "{}",
        error.message
    );
}

#[test]
fn transient_failures_wait_their_turn_without_blocking_other_files() {
    let mock = Mock::start();
    mock.get().knobs.fail_puts = vec![1];
    let (_tmp, dir, folder) = paired(&mock);
    write(&folder, "a.csv", &content(500));
    write(&folder, "b.csv", &content(600));

    let options = Options {
        settle: Duration::ZERO,
        retry_delays: vec![Duration::from_secs(60)],
    };
    let mut uploader = open(&dir, options);
    uploader.scan();
    drain(&mut uploader);

    let inner = mock.get();
    let sent: Vec<&str> = inner.completed.iter().map(|(p, _)| p.as_str()).collect();
    assert_eq!(sent, vec!["Exports/b.csv"]);
    let a = uploader
        .state()
        .queue
        .values()
        .find(|i| i.path == "Exports/a.csv")
        .unwrap();
    let Phase::RetryAfter { at, attempt, .. } = &a.phase else {
        panic!("a.csv should wait to retry, not {:?}", a.phase);
    };
    assert_eq!(*attempt, 1);
    assert!(*at > binary_labs_uploader::engine::now_ms() + 50_000);
}

#[test]
fn a_file_still_being_written_is_sent_only_after_it_stops_growing() {
    let mock = Mock::start();
    let (_tmp, dir, folder) = paired(&mock);
    let path = folder.join("growing.csv");
    std::fs::write(&path, b"").unwrap();

    let writer = {
        let path = path.clone();
        std::thread::spawn(move || {
            let mut file = OpenOptions::new().append(true).open(&path).unwrap();
            let mut last_write = Instant::now();
            for i in 0..10 {
                std::thread::sleep(Duration::from_millis(300));
                file.write_all(&content(100 + i)).unwrap();
                file.flush().unwrap();
                last_write = Instant::now();
            }
            last_write
        })
    };

    let options = Options {
        settle: Duration::from_secs(1),
        ..fast()
    };
    let mut uploader = open(&dir, options);
    let deadline = Instant::now() + Duration::from_secs(15);
    while mock.get().completed.is_empty() {
        assert!(Instant::now() < deadline, "the file was never sent");
        uploader.notice(&path, false);
        uploader.step().unwrap();
        std::thread::sleep(Duration::from_millis(50));
    }
    let last_write = writer.join().unwrap();

    let inner = mock.get();
    let first_check = inner
        .find("POST", "/api/instruments/files/check")
        .first()
        .map(|r| r.at)
        .unwrap();
    assert!(
        first_check >= last_write + Duration::from_secs(1),
        "checked before it was still for 1 s"
    );
    let final_bytes = std::fs::read(&path).unwrap();
    assert_eq!(final_bytes.len(), (100..110).sum::<usize>());
    assert_eq!(
        inner.completed,
        vec![("Exports/growing.csv".to_string(), final_bytes)]
    );
}

#[test]
fn temp_lock_and_hidden_files_are_skipped() {
    let mock = Mock::start();
    let (_tmp, dir, folder) = paired(&mock);
    let skipped = [
        "~$plate.xlsx",
        ".hidden.csv",
        "run.tmp",
        "db.LOCK",
        "Thumbs.db",
        "desktop.ini",
        ".git/config",
        "P450/.cache/x.csv",
    ];
    for rel in skipped {
        write(&folder, rel, b"skip me");
    }
    write(&folder, "P450/real.csv", b"send me");

    let mut uploader = open(&dir, fast());
    uploader.scan();
    for rel in skipped {
        uploader.notice(&folder.join(rel), true);
    }
    drain(&mut uploader);

    let checked: Vec<_> = mock
        .get()
        .checks()
        .iter()
        .map(|c| c["path"].clone())
        .collect();
    assert_eq!(checked, vec![json!("Exports/P450/real.csv")]);
}

#[test]
fn a_file_changed_mid_upload_cancels_the_session_and_starts_over() {
    let mock = Mock::start();
    let (_tmp, dir, folder) = paired(&mock);
    let path = write(&folder, "edit.csv", &content(3000));

    let mut uploader = open(&dir, fast());
    uploader.scan();
    step_until(&mut uploader, || mock.get().puts().len() == 1);
    let mut file = OpenOptions::new().append(true).open(&path).unwrap();
    file.write_all(b"one more row\n").unwrap();
    drop(file);
    drain(&mut uploader);

    let new_bytes = std::fs::read(&path).unwrap();
    let inner = mock.get();
    let deletes = inner.find("DELETE", "/api/instruments/uploads/up-1");
    assert_eq!(deletes.len(), 1);
    assert_eq!(deletes[0].json(), json!({ "storeId": "store-1" }));
    assert!(
        inner
            .with_prefix("POST", "/api/instruments/uploads/up-1/complete")
            .is_empty()
    );
    let starts = inner.find("POST", UPLOADS);
    assert_eq!(starts.len(), 2);
    assert_eq!(starts[1].json()["sha256"], sha_hex(&new_bytes));
    assert_eq!(
        inner.completed,
        vec![("Exports/edit.csv".to_string(), new_bytes)]
    );
}

#[test]
fn complete_answering_422_starts_the_file_over() {
    let mock = Mock::start();
    mock.get().knobs.complete_statuses = vec![422];
    let (_tmp, dir, folder) = paired(&mock);
    let bytes = content(1500);
    write(&folder, "redo.csv", &bytes);

    let mut uploader = open(&dir, fast());
    uploader.scan();
    drain(&mut uploader);

    let inner = mock.get();
    assert_eq!(inner.checks().len(), 2, "hashed and checked again");
    assert_eq!(inner.find("POST", UPLOADS).len(), 2, "a fresh session");
    assert_eq!(inner.puts(), vec![1, 2, 1, 2]);
    let first = inner.with_prefix("POST", "/api/instruments/uploads/up-1/complete");
    assert_eq!(
        first.len(),
        1,
        "the rejected session is dropped, not retried"
    );
    assert_eq!(
        inner.completed,
        vec![("Exports/redo.csv".to_string(), bytes)]
    );
    assert!(uploader.state().sent.contains_key("Exports/redo.csv"));
}

#[test]
fn relative_part_urls_get_the_token() {
    let mock = Mock::start();
    let (_tmp, dir, folder) = paired(&mock);
    write(&folder, "rel.csv", &content(2500));

    let mut uploader = open(&dir, fast());
    uploader.scan();
    drain(&mut uploader);

    let inner = mock.get();
    let puts = inner.with_prefix("PUT", "/api/instruments/uploads/");
    assert_eq!(puts.len(), 3);
    for put in puts {
        assert_eq!(
            put.auth.as_deref(),
            Some(format!("Bearer {TOKEN}").as_str())
        );
    }
}

#[test]
fn absolute_part_urls_never_get_the_token() {
    let mock = Mock::start();
    mock.get().knobs.absolute_parts = true;
    let (_tmp, dir, folder) = paired(&mock);
    let bytes = content(2500);
    write(&folder, "abs.csv", &bytes);

    let mut uploader = open(&dir, fast());
    uploader.scan();
    drain(&mut uploader);

    let inner = mock.get();
    let puts = inner.with_prefix("PUT", "/store/");
    assert_eq!(puts.len(), 3);
    for put in &puts {
        assert_eq!(put.auth, None, "token sent to {}", put.url);
    }
    for post in inner
        .requests
        .iter()
        .filter(|r| r.method == "POST" && !r.url.ends_with("/pair"))
    {
        assert!(post.auth.is_some(), "{} needs the token", post.url);
    }
    assert_eq!(
        inner.completed,
        vec![("Exports/abs.csv".to_string(), bytes)]
    );
}

#[test]
fn a_413_marks_the_file_too_large_until_it_changes() {
    let mock = Mock::start();
    mock.get().knobs.max_bytes = 100;
    let (_tmp, dir, folder) = paired(&mock);
    let path = write(&folder, "huge.raw", &content(200));

    let mut uploader = open(&dir, fast());
    uploader.scan();
    drain(&mut uploader);
    uploader.scan();
    drain(&mut uploader);

    assert_eq!(
        mock.get().checks().len(),
        1,
        "not asked about again while unchanged"
    );
    assert!(mock.get().with_prefix("POST", UPLOADS).is_empty());
    let item = uploader.state().queue.values().next().unwrap();
    assert_eq!(item.phase, Phase::TooLarge);
    let config = Config::load(&dir).unwrap();
    let report = status::render(
        &config,
        Some(uploader.state()),
        binary_labs_uploader::engine::now_ms(),
    );
    assert!(report.contains("Too large to send"), "{report}");
    assert!(report.contains("Exports/huge.raw (200 bytes)"), "{report}");

    mock.get().knobs.max_bytes = 10_000;
    std::fs::write(&path, content(150)).unwrap();
    uploader.scan();
    drain(&mut uploader);
    assert_eq!(
        mock.get().completed,
        vec![("Exports/huge.raw".to_string(), content(150))]
    );
}

#[test]
fn the_heartbeat_limit_skips_big_files_without_asking() {
    let mock = Mock::start();
    mock.get().knobs.max_bytes = 100;
    let (_tmp, dir, folder) = paired(&mock);
    write(&folder, "huge.raw", &content(200));

    let mut uploader = open(&dir, fast());
    uploader.heartbeat().unwrap();
    uploader.scan();
    drain(&mut uploader);

    assert!(mock.get().checks().is_empty());
    assert_eq!(
        uploader.state().queue.values().next().unwrap().phase,
        Phase::TooLarge
    );
}

#[test]
fn a_401_stops_the_engine_and_keeps_the_queue() {
    let mock = Mock::start();
    let (_tmp, dir, folder) = paired(&mock);
    write(&folder, "late.csv", &content(100));
    mock.get().knobs.unauthorized = true;

    let mut uploader = open(&dir, fast());
    assert!(uploader.heartbeat().is_err());
    uploader.scan();
    let mut result = Ok(true);
    for _ in 0..10 {
        result = uploader.step();
        if result.is_err() {
            break;
        }
    }
    assert!(result.is_err(), "a 401 must stop the engine");

    let saved = State::load(&dir).unwrap().unwrap();
    assert_eq!(
        saved.queue.len(),
        1,
        "the file stays queued for after pairing again"
    );
    assert_eq!(
        saved.last_error.unwrap().message,
        binary_labs_uploader::UNPAIRED_MESSAGE
    );
}
