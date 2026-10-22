use super::cloud::run_aliyun;
use super::cloud::run_deepgram;
use super::cloud::run_gemini;
use super::events::TranscriptSink;
use super::local::forward_until_idle;
use crate::proxy::ResolvedProxy;
use crate::voice::streaming::providers::run_soniox;
use crate::voice::streaming::providers::run_volcengine;

pub async fn run_online(
    app: TranscriptSink,
    session_id: String,
    chunks: tokio::sync::mpsc::Receiver<Vec<f32>>,
    provider: String,
    config: crate::ai::config::AsrProviderConfig,
    api_key: String,
    language: String,
    proxy: Option<ResolvedProxy>,
    hotwords: Vec<String>,
) -> Result<(), String> {
    if api_key.is_empty() || api_key.starts_with("vault:") {
        return Err("ASR_API_KEY_MISSING: configure an API key".into());
    }
    let words = super::super::vocabulary::validate(&hotwords)?;
    let vocabulary =
        super::super::vocabulary::prepare(&provider, &config, &api_key, &words, proxy.as_ref())
            .await?;
    let (sender, receiver) = tokio::sync::mpsc::channel(4);
    let forwarding = forward_until_idle(chunks, sender);
    let backend = async {
        let mut chunks = receiver;
        let started = std::time::Instant::now();
        match provider.as_str() {
            "soniox" => {
                run_soniox(
                    app,
                    session_id,
                    &mut chunks,
                    &config,
                    &api_key,
                    &language,
                    &words,
                    started,
                    proxy.as_ref(),
                )
                .await
            }
            "volcengine" => {
                run_volcengine(
                    app,
                    session_id,
                    &mut chunks,
                    &config,
                    &api_key,
                    &vocabulary,
                    started,
                    proxy.as_ref(),
                )
                .await
            }
            "deepgram" => {
                run_deepgram(
                    app,
                    session_id,
                    &mut chunks,
                    &config.model,
                    &config.endpoint,
                    &api_key,
                    &language,
                    started,
                    proxy.as_ref(),
                    &words,
                )
                .await
            }
            "aliyun" => {
                run_aliyun(
                    app,
                    session_id,
                    &mut chunks,
                    &config.model,
                    &config.endpoint,
                    &api_key,
                    &language,
                    started,
                    proxy.as_ref(),
                    &vocabulary,
                )
                .await
            }
            "gemini" => {
                run_gemini(
                    app,
                    session_id,
                    &mut chunks,
                    &config.model,
                    &config.endpoint,
                    &api_key,
                    &language,
                    started,
                    proxy.as_ref(),
                )
                .await
            }
            _ => Err("ASR_PROVIDER_UNAVAILABLE".into()),
        }
    };
    tokio::pin!(backend);
    tokio::pin!(forwarding);
    tokio::select! {
        result = &mut backend => result,
        _ = &mut forwarding => tokio::time::timeout(std::time::Duration::from_secs(15), &mut backend)
            .await.unwrap_or_else(|_| Err("ASR_FINAL_TIMEOUT: no provider completion after audio ended".into())),
    }
}
