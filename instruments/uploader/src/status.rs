use crate::config::Config;
use crate::state::{Phase, State, Work};

const MAX_LISTED: usize = 20;

pub fn render(config: &Config, state: Option<&State>, now: u64) -> String {
    let empty = State::default();
    let state = state.unwrap_or(&empty);
    let mut lines = vec![
        format!("Server: {}", config.server),
        format!(
            "Instrument: {} in {}",
            config.instrument.name, config.lab.name
        ),
    ];
    if config.folders.is_empty() {
        lines.push("Folders: none yet. Add one with add-folder.".into());
    } else {
        lines.push("Folders:".into());
        for folder in &config.folders {
            lines.push(format!("  {} ({})", folder.label, folder.path.display()));
        }
    }

    let (too_large, queue): (Vec<_>, Vec<_>) = state
        .queue
        .values()
        .partition(|item| item.phase == Phase::TooLarge);
    if queue.is_empty() {
        lines.push("Queue: nothing waiting".into());
    } else {
        lines.push(format!("Queue: {}", count(queue.len(), "file")));
        let rows = queue
            .iter()
            .map(|item| format!("  {}: {}", item.path, describe(&item.phase, now)));
        list(&mut lines, rows);
    }
    if !too_large.is_empty() {
        lines.push("Too large to send (skipped until they change):".into());
        let rows = too_large
            .iter()
            .map(|item| format!("  {} ({})", item.path, bytes(item.stat.size)));
        list(&mut lines, rows);
    }

    lines.push(format!("Files sent: {}", state.sent.len()));
    let last_sync = state.last_sync.map_or("never".into(), |at| ago(now, at));
    lines.push(format!("Last sync: {last_sync}"));
    lines.push(match &state.last_error {
        Some(e) => format!("Last error: {} ({})", e.message, ago(now, e.at)),
        None => "Last error: none".into(),
    });
    lines.join("\n") + "\n"
}

fn list(lines: &mut Vec<String>, rows: impl ExactSizeIterator<Item = String>) {
    let total = rows.len();
    lines.extend(rows.take(MAX_LISTED));
    if total > MAX_LISTED {
        lines.push(format!("  and {} more", total - MAX_LISTED));
    }
}

fn describe(phase: &Phase, now: u64) -> String {
    match phase {
        Phase::Settling { .. } => "waiting for the file to be still".into(),
        Phase::Work(work) => describe_work(work),
        Phase::RetryAfter {
            at, reason, then, ..
        } => format!(
            "{}, trying again {} ({reason})",
            describe_work(then),
            from_now(now, *at)
        ),
        Phase::TooLarge => "too large to send".into(),
    }
}

fn describe_work(work: &Work) -> String {
    match work {
        Work::Hash => "waiting to be read".into(),
        Work::Check { .. } => "waiting to be checked with the lab".into(),
        Work::Upload { session, .. } => format!(
            "uploading, {} of {} parts sent",
            session.etags.len(),
            session.parts
        ),
    }
}

fn count(n: usize, noun: &str) -> String {
    if n == 1 {
        format!("1 {noun}")
    } else {
        format!("{n} {noun}s")
    }
}

fn ago(now: u64, at: u64) -> String {
    let secs = now.saturating_sub(at) / 1000;
    match secs {
        0..60 => "just now".into(),
        60..3600 => format!("{} ago", count((secs / 60) as usize, "minute")),
        3600..86400 => format!("{} ago", count((secs / 3600) as usize, "hour")),
        _ => format!("{} ago", count((secs / 86400) as usize, "day")),
    }
}

fn from_now(now: u64, at: u64) -> String {
    let secs = at.saturating_sub(now) / 1000;
    match secs {
        0 => "now".into(),
        1..60 => format!("in {secs} s"),
        _ => format!("in {} min", secs.div_ceil(60)),
    }
}

fn bytes(n: u64) -> String {
    const UNITS: [&str; 4] = ["KB", "MB", "GB", "TB"];
    if n < 1000 {
        return format!("{n} bytes");
    }
    let mut value = n as f64;
    let mut unit = "bytes";
    for u in UNITS {
        if value < 1000.0 {
            break;
        }
        value /= 1000.0;
        unit = u;
    }
    format!("{value:.1} {unit}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes_and_times_read_plainly() {
        assert_eq!(bytes(999), "999 bytes");
        assert_eq!(bytes(600_000_000), "600.0 MB");
        assert_eq!(ago(10_000_000, 10_000_000 - 90_000), "1 minute ago");
        assert_eq!(from_now(0, 125_000), "in 3 min");
    }
}
