//! QA-only WebDriver bridge for macOS WKWebView runs.
//!
//! `tauri-driver` has no macOS adapter.  The QA runner therefore starts the
//! packaged QA binary with `TAOMNI_QA_WEBDRIVER_PORT` and talks to this small
//! W3C-compatible server.  The bridge is deliberately opt-in and is never
//! started for normal application launches.

mod model;

mod response;

mod evaluation;

mod session;
mod windows;

mod elements;

mod actions;

mod capture;

mod about;

mod server;

pub use server::start;
