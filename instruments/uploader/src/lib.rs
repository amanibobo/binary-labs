//! Sends new and changed files from an instrument PC's folders to a Binary lab.
//! It only ever reads the watched files.

pub mod api;
pub mod config;
pub mod engine;
pub mod files;
pub mod run;
pub mod setup;
pub mod state;
pub mod status;
mod store;

pub use engine::{Options, UNPAIRED_MESSAGE, Unpaired, Uploader};
