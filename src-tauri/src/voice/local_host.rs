//! Core adapter for the authenticated Local Voice host channel.

use std::{path::PathBuf, sync::Arc};

use serde::Serialize;
use taomni_local_voice_api::{
    Mode, ModelSelection, PREPARE, Reply, SLUG, START, Start, Transcript, finish_audio, read_reply,
    write_audio,
};
use taomni_plugin_stream::routed_tcp::Route;
use tokio::{io::AsyncWrite, sync::mpsc};
use tokio_util::sync::CancellationToken;

use crate::plugin::{LifecycleState, PluginRegistry};

pub(crate) fn use_host(plugins: &PluginRegistry) -> Result<bool, String> {
    match plugins.get(SLUG) {
        Some(record) if record.state == LifecycleState::Enabled => Ok(true),
        Some(record) if record.state != LifecycleState::Uninstalled => {
            Err("ASR_MODULE_DISABLED: Enable Local Voice in Settings → Module Store.".into())
        }
        None if cfg!(any(feature = "asr-whisper", feature = "asr-sherpa")) => Ok(false),
        _ => Err("ASR_MODULE_REQUIRED: Install Local Voice from Settings → Module Store.".into()),
    }
}

pub(crate) fn absolute(path: PathBuf) -> PathBuf {
    if path.is_absolute() {
        path
    } else {
        std::env::current_dir().map_or(path.clone(), |root| root.join(path))
    }
}

pub(crate) async fn prepare(
    plugins: &Arc<PluginRegistry>,
    selection: &ModelSelection,
    cancel: &CancellationToken,
) -> Result<(), String> {
    invoke(plugins, PREPARE, selection, cancel).await
}

pub(crate) enum Input {
    Buffer(Vec<f32>),
    Live(mpsc::Receiver<Vec<f32>>),
}

pub(crate) async fn run(
    plugins: &Arc<PluginRegistry>,
    selection: ModelSelection,
    mode: Mode,
    input: Input,
    cancel: &CancellationToken,
    mut transcript: impl FnMut(Transcript),
) -> Result<(), String> {
    let (_route, channel, peer) = Route::pair().await.map_err(|error| error.to_string())?;
    invoke(
        plugins,
        START,
        &Start {
            selection,
            mode,
            channel,
        },
        cancel,
    )
    .await?;
    let (mut read, mut write) = tokio::io::split(peer);
    let input = async {
        pump(&mut write, input)
            .await
            .map_err(|error| error.to_string())?;
        // The open write end distinguishes a clean end of audio from cancellation.
        std::future::pending::<Result<(), String>>().await
    };
    let output = async {
        loop {
            match read_reply(&mut read)
                .await
                .map_err(|error| format!("Local Voice connection closed: {error}"))?
            {
                Reply::Transcript(value) => transcript(value),
                Reply::Complete(result) => return result,
            }
        }
    };
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err("Cancelled".into()),
        result = output => result,
        result = input => result,
    }
}

async fn pump(write: &mut (impl AsyncWrite + Unpin), input: Input) -> std::io::Result<()> {
    match input {
        Input::Buffer(pcm) => write_audio(write, &pcm).await?,
        Input::Live(mut chunks) => {
            while let Some(chunk) = chunks.recv().await {
                write_audio(write, &chunk).await?;
            }
        }
    }
    finish_audio(write).await
}

async fn invoke(
    plugins: &Arc<PluginRegistry>,
    method: &'static str,
    payload: &impl Serialize,
    cancel: &CancellationToken,
) -> Result<(), String> {
    let value = serde_json::to_value(payload).map_err(|error| error.to_string())?;
    let call = Call::new(plugins, cancel);
    let pending = call.plugins.clone();
    let id = call.id.clone();
    let token = call.token.clone();
    let job = tokio::task::spawn_blocking(move || {
        pending.invoke_cancellable(SLUG, method, value, &id, || token.is_cancelled())
    });
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err("Cancelled".into()),
        result = job => {
            result.map_err(|error| error.to_string())?.map_err(|error| error.to_string())?;
            Ok(())
        }
    }
}

struct Call<'a> {
    plugins: &'a Arc<PluginRegistry>,
    id: String,
    token: CancellationToken,
}

impl<'a> Call<'a> {
    fn new(plugins: &'a Arc<PluginRegistry>, owner: &CancellationToken) -> Self {
        Self {
            plugins,
            id: uuid::Uuid::new_v4().to_string(),
            token: owner.child_token(),
        }
    }
}

impl Drop for Call<'_> {
    fn drop(&mut self) {
        self.token.cancel();
        self.plugins.cancel_request(SLUG, &self.id);
    }
}
