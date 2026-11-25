//! Compile the production module downloader without the desktop application.
//! Networking tests are ignored by default and run only on GitHub runners.

#[path = "../../../src/plugin/download.rs"]
pub mod download;
