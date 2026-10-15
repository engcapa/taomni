//! Availability comes from the gateway, never from a deprecated metadata flag.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::HashMap, path::PathBuf, sync::{Arc, OnceLock, RwLock}};
use tokio::sync::Mutex;

pub const TTL_SECONDS: u64 = 6 * 60 * 60;
pub use crate::llm::model_catalog::METADATA_URL;
pub const SNAPSHOT: &str = include_str!("../../../resources/opencode-go-catalog.snapshot.json");
const SEED: &str = include_str!("../../../../scripts/opencode-go-protocol-seed.json");

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GoModelEntry {
    pub id: String,
    pub name: String,
    pub protocol: String,
    pub protocol_source: String,
    pub context_limit: Option<u64>,
    pub output_limit: Option<u64>,
    pub cost: Value,
    pub input_modalities: Vec<String>,
    pub tool_call: bool,
    pub reasoning: bool,
    pub interleaved_field: Option<String>,
    pub status: Option<String>,
    pub training_use: bool,
    pub base_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoCatalogDto {
    #[serde(serialize_with = "serialize_models", deserialize_with = "deserialize_models")]
    pub models: Arc<Vec<GoModelEntry>>,
    pub fetched_at: u64,
    pub source: String,
    pub last_error: Option<String>,
}

fn serialize_models<S: serde::Serializer>(models: &Arc<Vec<GoModelEntry>>, serializer: S) -> Result<S::Ok, S::Error> {
    models.as_ref().serialize(serializer)
}
fn deserialize_models<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Arc<Vec<GoModelEntry>>, D::Error> {
    Vec::<GoModelEntry>::deserialize(deserializer).map(Arc::new)
}

pub fn npm_protocol(meta: &Value, provider: &Value) -> Option<&'static str> {
    match meta["provider"]["npm"].as_str().or(provider["npm"].as_str())? {
        "@ai-sdk/openai-compatible" => Some("chat"),
        "@ai-sdk/anthropic" => Some("messages"),
        "@ai-sdk/openai" => Some(if meta["provider"]["shape"] == "completions" { "chat" } else { "responses" }),
        "@ai-sdk/google" => Some("google"),
        _ => None,
    }
}

pub fn valid_protocol(protocol: &str) -> &str {
    match protocol {
        "chat" | "messages" | "responses" | "google" => protocol,
        _ => {
            tracing::warn!(protocol, "unknown Go protocol; using chat");
            "chat"
        }
    }
}

pub fn merge(ids: &[String], metadata: &Value, snapshot: &Value, overrides: &HashMap<String, String>) -> Vec<GoModelEntry> {
    let seed: Value = serde_json::from_str(SEED).expect("embedded protocol seed");
    let mut ids = ids.to_vec();
    ids.sort();
    ids.dedup();
    ids.into_iter().map(|id| {
        let live_meta = &metadata["models"][&id];
        let meta = if live_meta.is_object() { live_meta } else { &snapshot["models"][&id] };
        let provider = if live_meta.is_object() { metadata } else { snapshot };
        let seeded = seed["models"][&id].as_str();
        let npm = npm_protocol(meta, provider);
        if let (Some(a), Some(b)) = (seeded, npm) {
            if a != b { tracing::warn!(model = %id, "Go seed overrides metadata protocol"); }
        }
        let (protocol, source) = if let Some(p) = overrides.get(&id) {
            (valid_protocol(p).to_string(), "user_override")
        } else if let Some(p) = seeded {
            (p.to_string(), "seed")
        } else if let Some(p) = npm.filter(|_| live_meta.is_object() && !live_meta.as_object().unwrap().is_empty()) {
            (p.to_string(), "models_dev")
        } else {
            ("chat".into(), "default")
        };
        GoModelEntry {
            name: meta["name"].as_str().unwrap_or(&id).into(),
            protocol, protocol_source: source.into(),
            context_limit: meta["limit"]["context"].as_u64(),
            output_limit: meta["limit"]["output"].as_u64(),
            cost: meta["cost"].clone(),
            input_modalities: meta["modalities"]["input"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default(),
            tool_call: meta["tool_call"].as_bool().unwrap_or(true),
            reasoning: meta["reasoning"].as_bool().unwrap_or(false),
            interleaved_field: meta["interleaved"]["field"].as_str().map(String::from),
            status: meta["status"].as_str().map(String::from),
            training_use: id == "gemini-4-argon-contributor" || id.starts_with("muse-spark-"),
            base_url: meta["provider"]["api"].as_str().map(String::from),
            id,
        }
    }).collect()
}

pub fn digest(models: &[GoModelEntry]) -> String {
    Sha256::digest(serde_json::to_vec(models).expect("catalog serialization"))
        .iter().map(|b| format!("{b:02x}")).collect()
}
pub fn session_key(thread_id: &str) -> String {
    Sha256::digest(thread_id.as_bytes())[..16].iter().map(|b| format!("{b:02x}")).collect()
}
fn now() -> u64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs() }
fn snapshot_models() -> Vec<GoModelEntry> {
    let source: Value = serde_json::from_str(SNAPSHOT).expect("embedded Go snapshot");
    let ids = source["models"].as_object().expect("snapshot models").keys().cloned().collect::<Vec<_>>();
    merge(&ids, &source, &source, &HashMap::new())
}

#[derive(Serialize, Deserialize)]
struct Cache { fetched_at: u64, digest: String, models: Vec<GoModelEntry> }
#[derive(Clone, PartialEq)]
struct Settings { base: String, proxy: Result<Option<String>, String>, blocked: bool }

pub struct CatalogService {
    pub metadata: Arc<crate::llm::model_catalog::ModelCatalog>,
    state: RwLock<GoCatalogDto>,
    settings: RwLock<Settings>,
    gate: Mutex<()>,
    attempts: std::sync::atomic::AtomicU64,
    cache: PathBuf,
    metadata_url: String,
    cancel: RwLock<tokio_util::sync::CancellationToken>,
}
impl CatalogService {
    #[cfg(test)]
    pub(super) fn with_metadata_url(mut self, url: String) -> Self {
        self.metadata_url = url;
        self
    }
    pub fn new(cache: PathBuf) -> Self {
        let cached = std::fs::read(&cache).ok().and_then(|b| serde_json::from_slice::<Cache>(&b).ok())
            .filter(|c| !c.models.is_empty() && c.digest == digest(&c.models) && c.models.iter().all(|m| !m.id.is_empty() && matches!(m.protocol.as_str(), "chat" | "messages" | "responses" | "google")));
        let dto = match cached {
            Some(c) => GoCatalogDto { models: Arc::new(c.models), fetched_at: c.fetched_at, source: "cache".into(), last_error: None },
            None => GoCatalogDto { models: Arc::new(snapshot_models()), fetched_at: 0, source: "snapshot".into(), last_error: None },
        };
        Self { metadata: crate::llm::model_catalog::shared(), state: RwLock::new(dto), settings: RwLock::new(Settings { base: "https://opencode.ai/inference/go/v1".into(), proxy: Ok(None), blocked: true }), gate: Mutex::new(()), attempts: 0.into(), cache, metadata_url: METADATA_URL.into(), cancel: RwLock::new(tokio_util::sync::CancellationToken::new()) }
    }
    pub fn configure(&self, base: String, proxy: Result<Option<String>, String>, blocked: bool) {
        self.metadata.configure_network_policy(blocked);
        let next = Settings { base, proxy, blocked };
        let mut settings = self.settings.write().unwrap();
        if *settings != next {
            let mut token = self.cancel.write().unwrap();
            token.cancel();
            *token = tokio_util::sync::CancellationToken::new();
            *settings = next;
        }
    }
    pub fn get(&self) -> GoCatalogDto { self.state.read().unwrap().clone() }
    pub fn trigger(self: &Arc<Self>, force: bool) {
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            let service = self.clone();
            handle.spawn(async move { service.refresh(force).await; });
        }
    }
    pub async fn refresh(&self, force: bool) -> GoCatalogDto {
        use std::sync::atomic::Ordering;
        let attempt = self.attempts.load(Ordering::SeqCst);
        let _guard = self.gate.lock().await;
        let (settings, cancel) = {
            let settings = self.settings.read().unwrap();
            (settings.clone(), self.cancel.read().unwrap().clone())
        };
        let current = self.get();
        if settings.blocked || attempt != self.attempts.load(Ordering::SeqCst)
            || (!force && current.fetched_at > 0 && now().saturating_sub(current.fetched_at) < TTL_SECONDS) { return current; }
        let result = tokio::select! {
            _ = cancel.cancelled() => {
                self.attempts.fetch_add(1, Ordering::SeqCst);
                return self.get();
            },
            result = self.fetch(&settings, &current) => result,
        };
        // Mark completion, not start: callers arriving during HTTP must
        // observe the generation change after waiting for the same flight.
        self.attempts.fetch_add(1, Ordering::SeqCst);
        // A policy/config change while HTTP was in flight must not publish stale results.
        if *self.settings.read().unwrap() != settings { return self.get(); }
        match result {
            Ok((models, warning, source)) => {
                let hash = digest(&models);
                let mut state = self.state.write().unwrap();
                let changed = hash != digest(&state.models);
                if changed || !self.cache.exists() {
                    let cache = Cache { fetched_at: now(), digest: hash, models: models.clone() };
                    let write = (|| -> std::io::Result<()> {
                        if let Some(dir) = self.cache.parent() { std::fs::create_dir_all(dir)?; }
                        let temp = self.cache.with_extension("json.tmp");
                        std::fs::write(&temp, serde_json::to_vec(&cache)?)?;
                        // Same directory, atomic publication on supported desktop platforms.
                        std::fs::rename(temp, &self.cache)
                    })();
                    if changed { state.models = Arc::new(models); }
                    state.last_error = write.err().map(|e| format!("Catalog cache: {e}")).or(warning);
                } else { state.last_error = warning; }
                state.fetched_at = now();
                state.source = source;
            }
            Err(e) => self.state.write().unwrap().last_error = Some(e),
        }
        self.get()
    }
    async fn fetch(&self, settings: &Settings, current: &GoCatalogDto) -> Result<(Vec<GoModelEntry>, Option<String>, String), String> {
        let proxy = settings.proxy.clone()?;
        let client = super::client(proxy.as_deref(), 10).map_err(|e| e.to_string())?;
        let s1 = async {
            let value: Value = client.get(format!("{}/models", settings.base.trim_end_matches('/'))).send().await?.error_for_status()?.json().await?;
            Ok::<_, reqwest::Error>(value)
        };
        let s2 = async {
            let catalog = if self.metadata_url == METADATA_URL { self.metadata.clone() }
                else { Arc::new(crate::llm::model_catalog::ModelCatalog::new(self.cache.with_extension("metadata.json"))) };
            let data = catalog.refresh(settings.proxy.clone(), settings.blocked, true, &self.metadata_url).await;
            match data.last_error {
                Some(error) => Err(error),
                None => Ok(data.providers),
            }
        };
        let (live, metadata) = tokio::join!(s1, s2);
        let snapshot: Value = serde_json::from_str(SNAPSHOT).unwrap();
        let ids = live.as_ref().ok().and_then(|v| v["data"].as_array()).map(|a| a.iter().filter_map(|v| v["id"].as_str().map(String::from)).collect::<Vec<_>>());
        let meta = metadata.as_ref().ok().map(|v| &v["opencode-go"]).filter(|v| v["models"].is_object());
        if ids.is_none() && meta.is_none() {
            return Err("Go catalog refresh failed: gateway and metadata unreachable or invalid; retained last-good catalog".into());
        }
        let fallback = current.models.iter().map(|m| m.id.clone()).collect::<Vec<_>>();
        let warning = if ids.is_none() || meta.is_none() { Some("Partial catalog refresh: retained unavailable source".into()) } else { None };
        let mut models = merge(ids.as_ref().unwrap_or(&fallback), meta.unwrap_or(&snapshot), &snapshot, &HashMap::new());
        for model in &mut models {
            if !meta.is_some_and(|m| m["models"][&model.id].is_object()) {
                if let Some(old) = current.models.iter().find(|m| m.id == model.id) {
                    let protocol = model.protocol.clone();
                    let source = model.protocol_source.clone();
                    *model = old.clone();
                    if source == "seed" {
                        model.protocol = protocol;
                        model.protocol_source = source;
                    }
                }
            }
        }
        let source = if ids.is_some() {"live".into()} else {current.source.clone()};
        Ok((models, warning, source))
    }
}

pub fn shared_catalog() -> Arc<CatalogService> {
    static SERVICE: OnceLock<Arc<CatalogService>> = OnceLock::new();
    SERVICE.get_or_init(|| Arc::new(CatalogService::new(crate::ai::config::default_ai_config_path().with_file_name("opencode-go-catalog.json")))).clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn availability_badges_priority_and_digest() {
        let fixture: Value = serde_json::from_str(include_str!("../../../../docs-feature/opencode-go-provider/fixtures/available.synthetic.json")).unwrap();
        let metadata: Value = serde_json::from_str(include_str!("../../../../docs-feature/opencode-go-provider/fixtures/metadata.synthetic.json")).unwrap();
        let fixture_ids = fixture["data"].as_array().unwrap().iter().filter_map(|v| v["id"].as_str()).map(str::to_owned).collect::<Vec<_>>();
        assert!(!fixture_ids.contains(&"deepseek-v4-flash".to_string()));
        let fixture_models = merge(&fixture_ids, &metadata["opencode-go"], &serde_json::from_str(SNAPSHOT).unwrap(), &HashMap::new());
        assert_eq!(fixture_models.iter().find(|m| m.id == "kimi-k2.6").unwrap().protocol, "chat");
        assert_eq!(fixture_models.iter().find(|m| m.id == "kimi-k2.6").unwrap().protocol_source, "seed");
        assert_eq!(fixture_models.iter().find(|m| m.id == "fresh-anthropic-model").unwrap().protocol, "messages");
        assert_eq!(fixture_models.iter().find(|m| m.id == "fresh-anthropic-model").unwrap().protocol_source, "models_dev");
        assert_eq!(fixture_models.iter().find(|m| m.id == "omen-alpha").unwrap().protocol_source, "default");
        let ids = vec!["kimi-k2.6".into(), "omen-alpha".into(), "grok-4.7".into()];
        let meta = json!({"npm":"@ai-sdk/openai-compatible","models":{"kimi-k2.6":{"status":"deprecated"},"grok-4.7":{"provider":{"npm":"@ai-sdk/google"}},"deepseek-v4-flash":{}}});
        let snapshot: Value = serde_json::from_str(SNAPSHOT).unwrap();
        let models = merge(&ids, &meta, &snapshot, &HashMap::new());
        assert_eq!(models.len(), 3);
        assert_eq!(models[0].protocol, "responses");
        assert_eq!(models[1].status.as_deref(), Some("deprecated"));
        assert_eq!(models[2].protocol_source, "default");
        let override_map = HashMap::from([("grok-4.7".into(), "messages".into())]);
        assert_eq!(merge(&ids, &meta, &snapshot, &override_map)[0].protocol, "messages");
        assert_eq!(digest(&models), digest(&merge(&ids, &meta, &snapshot, &HashMap::new())));
        assert_eq!(valid_protocol("future"), "chat");
    }
    #[tokio::test]
    async fn corrupt_cache_and_policy_never_connect() {
        let path = std::env::temp_dir().join(format!("go-catalog-{}.json", uuid::Uuid::new_v4()));
        std::fs::write(&path, "broken").unwrap();
        let service = CatalogService::new(path.clone());
        let before = service.get();
        service.configure("http://127.0.0.1:1".into(), Err("bad proxy".into()), true);
        let after = service.refresh(true).await;
        assert_eq!(after.source, "snapshot");
        assert!(Arc::ptr_eq(&before.models, &after.models));
        assert!(after.last_error.is_none());
        service.configure("http://127.0.0.1:1".into(), Err("bad proxy".into()), false);
        assert_eq!(service.refresh(true).await.last_error.as_deref(), Some("bad proxy"));
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn refresh_coalesces_preserves_pointer_and_disk_fallback() {
        let metadata = json!({"opencode-go":{"npm":"@ai-sdk/openai-compatible","models":{"new-model":{"name":"New","tool_call":false}}}});
        let (base,requests,task) = super::super::test_gateway::start(4,move |raw| {
            if raw.starts_with("GET /models ") { (200,json!({"data":[{"id":"new-model"}]}).to_string(),"application/json") }
            else { (200,metadata.to_string(),"application/json") }
        }).await;
        let path = std::env::temp_dir().join(format!("go-catalog-{}.json",uuid::Uuid::new_v4()));
        let mut service = CatalogService::new(path.clone());
        service.metadata_url = format!("{base}/metadata");
        service.configure(base,Ok(None),false);
        let (a,b) = tokio::join!(service.refresh(true),service.refresh(true));
        assert_eq!(a.models[0].id,"new-model");
        assert!(!a.models[0].tool_call);
        assert!(Arc::ptr_eq(&a.models,&b.models));
        assert_eq!(requests.lock().unwrap().len(),2);
        let second = service.refresh(true).await;
        assert!(Arc::ptr_eq(&a.models,&second.models));
        task.await.unwrap();
        assert_eq!(requests.lock().unwrap().len(),4);
        let cached = CatalogService::new(path.clone());
        assert_eq!(cached.get().source,"cache");
        assert_eq!(cached.get().models[0].id,"new-model");
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn gateway_failure_retains_availability_and_total_failure_retains_last_good() {
        let (base,_,task) = super::super::test_gateway::start(2, |raw| {
            if raw.starts_with("GET /models ") { (503,"unavailable".into(),"text/plain") }
            else { (200,json!({"opencode-go":{"npm":"@ai-sdk/openai-compatible","models":{"added-only-in-metadata":{"name":"Not available"}}}}).to_string(),"application/json") }
        }).await;
        let path = std::env::temp_dir().join(format!("go-catalog-{}.json",uuid::Uuid::new_v4()));
        let mut service = CatalogService::new(path.clone());
        service.metadata_url = format!("{base}/metadata");
        service.configure(base,Ok(None),false);
        let result = service.refresh(true).await;
        assert!(!result.models.iter().any(|m| m.id == "added-only-in-metadata"));
        assert!(result.models.iter().any(|m| m.id == "kimi-k2.6"));
        assert!(result.last_error.is_some());
        task.await.unwrap();
        service.configure("http://127.0.0.1:1".into(),Ok(None),false);
        let last = service.refresh(true).await;
        assert!(Arc::ptr_eq(&result.models,&last.models));
        assert!(last.last_error.is_some());
        let _ = std::fs::remove_file(path);
    }
}
