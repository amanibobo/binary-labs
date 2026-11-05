use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

use anyhow::Context;
use binary_labs_uploader::config::{self, Config};
use binary_labs_uploader::state::State;
use binary_labs_uploader::{Options, engine, run, setup, status};
use clap::{Parser, Subcommand};
use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::fmt::writer::MakeWriterExt;

#[derive(Parser)]
#[command(
    name = "binary-labs-uploader",
    version,
    about = "Sends new files from this PC's instrument folders to Binary. It never changes them."
)]
struct Cli {
    /// Where settings, the upload queue and logs live.
    #[arg(
        long,
        global = true,
        env = "BINARY_LABS_UPLOADER_DIR",
        value_name = "DIR"
    )]
    config_dir: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Pair this PC with a lab, using a code from Settings > Instruments.
    Pair {
        /// The Binary address, like https://app.binarylabs.example
        server: String,
        code: String,
    },
    /// Send the files in this folder and every folder inside it.
    AddFolder { path: PathBuf },
    /// Watch the folders and send new and changed files until stopped.
    Run {
        /// Seconds a file must stay unchanged before it is sent.
        #[arg(long, default_value_t = 10)]
        settle_secs: u64,
        /// Seconds between full rescans of the folders, in case the watcher missed something.
        #[arg(long, default_value_t = 300)]
        rescan_secs: u64,
    },
    /// Show the folders, the queue and the last sync.
    Status,
}

fn main() -> ExitCode {
    match start() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{e:#}");
            ExitCode::FAILURE
        }
    }
}

fn start() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let dir = match cli.config_dir {
        Some(dir) => dir,
        None => config::default_dir().context("Couldn't find this user's settings folder")?,
    };
    match cli.command {
        Command::Pair { server, code } => {
            let config = setup::pair(&dir, &server, &code)?;
            println!(
                "Paired as {} in {}.",
                config.instrument.name, config.lab.name
            );
            if config.folders.is_empty() {
                println!(
                    "Next, add the folder the instrument saves to: binary-labs-uploader add-folder <folder>"
                );
            }
        }
        Command::AddFolder { path } => {
            let folder = setup::add_folder(&dir, &path)?;
            let instrument = Config::load(&dir)?.instrument.name;
            println!("Watching {}.", folder.path.display());
            println!(
                "Its files will show up in Binary under Instruments/{instrument}/{}. \
                 A running uploader picks this up within a minute.",
                folder.label
            );
        }
        Command::Run {
            settle_secs,
            rescan_secs,
        } => {
            Config::load(&dir)?;
            init_logs(&dir)?;
            let options = Options {
                settle: Duration::from_secs(settle_secs),
                ..Options::default()
            };
            run::run(&dir, options, Duration::from_secs(rescan_secs.max(1)))?;
        }
        Command::Status => {
            let config = Config::load(&dir)?;
            let state = State::load(&dir)?;
            print!(
                "{}",
                status::render(&config, state.as_ref(), engine::now_ms())
            );
        }
    }
    Ok(())
}

fn init_logs(dir: &Path) -> anyhow::Result<()> {
    let logs = dir.join("logs");
    let file = RollingFileAppender::builder()
        .rotation(Rotation::DAILY)
        .filename_prefix("uploader")
        .filename_suffix("log")
        .max_log_files(14)
        .build(&logs)
        .with_context(|| format!("Couldn't create the log folder {}", logs.display()))?;
    tracing_subscriber::fmt()
        .with_writer(std::io::stdout.and(file))
        .with_target(false)
        .with_max_level(tracing::Level::INFO)
        .init();
    Ok(())
}
