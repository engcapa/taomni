//! Realtime speech-to-text backends.
//!
//! The capture thread owns the microphone. This module consumes bounded
//! ~100 ms chunks and emits two kinds of events: `interim` hypotheses which
//! may be replaced, and `final` utterances which the UI commits. Keeping this
//! contract provider-neutral lets local sherpa and WebSocket services share
//! the same editor behavior.

#[path = "providers.rs"]
mod providers;

use crate::proxy::ResolvedProxy;

use base64::Engine;

use futures::{SinkExt, StreamExt};

use serde::Serialize;

use std::path::PathBuf;

use tauri::{AppHandle, Emitter};

use tokio::io::{AsyncReadExt, AsyncWriteExt};

use tokio::net::TcpStream;

use url::Url;

use providers::{run_soniox, run_volcengine};

mod events;

mod local;

mod routing;

mod transport;

mod cloud;

#[cfg(test)]
mod tests;

pub use events::{TranscriptEvent, TranscriptSink, event_sink};

use events::{emit, pcm16};

pub use local::run_routed_local;

#[cfg(any(feature = "asr-sherpa", not(feature = "asr-sherpa")))]
pub use local::run_local;

use local::{forward_until_idle, sherpa_model_dir};

pub use routing::run_online;

use transport::{connect_ws, connect_ws_inner, http_connect, socks5_connect, ws_request};

use cloud::{run_aliyun, run_deepgram, run_gemini};
