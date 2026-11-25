//! Single models.dev fetch/cache/digest owner, shared by Go and the inspector.
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{Value, value::RawValue};
use sha2::{Digest, Sha256};
use std::{
    path::PathBuf,
    sync::{Arc, RwLock},
};
use tokio::sync::Mutex;

pub const METADATA_URL: &str = "https://models.opencode.ai/api.json";
pub const SNAPSHOT: &str = include_str!("../../resources/model-catalog.snapshot.json");
pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
type Providers = Arc<IndexMap<String, Box<RawValue>>>;

#[derive(Clone, Serialize, Deserialize)]
pub struct CatalogData<P = Providers> {
    providers: P,
    pub fetched_at: u64,
    pub source: String,
    pub last_error: Option<String>,
    pub digest: String,
}

impl CatalogData {
    pub fn provider(&self, key: &str) -> Value {
        self.providers.get(key).map_or(Value::Null, |raw| {
            serde_json::from_str(raw.get()).expect("validated provider metadata")
        })
    }
}

fn compact_providers(value: Value) -> Option<(Providers, String)> {
    let Value::Object(entries) = value else {
        return None;
    };
    if entries.is_empty() {
        return None;
    }
    // Keep the original serde_json::Map iteration order for the legacy digest.
    let mut providers = IndexMap::with_capacity(entries.len());
    for (key, entry) in entries {
        if !entry["models"].is_object() {
            return None;
        }
        providers.insert(
            key,
            serde_json::value::to_raw_value(&entry).expect("serialize provider metadata"),
        );
    }
    let canonical = serde_json::to_vec(&providers).expect("serialize provider map");
    let digest = hex::encode(Sha256::digest(canonical));
    Some((Arc::new(providers), digest))
}

fn load_cache(bytes: &[u8]) -> Option<CatalogData> {
    let cached: CatalogData<Value> = serde_json::from_slice(bytes).ok()?;
    let (providers, digest) = compact_providers(cached.providers)?;
    (digest == cached.digest).then(|| CatalogData {
        providers,
        digest,
        fetched_at: cached.fetched_at,
        source: "cache".into(),
        last_error: None,
    })
}

pub struct ModelCatalog {
    state: RwLock<CatalogData>,
    gate: Mutex<()>,
    path: PathBuf,
    attempts: std::sync::atomic::AtomicU64,
    blocked: std::sync::atomic::AtomicBool,
    cancel: RwLock<tokio_util::sync::CancellationToken>,
}
impl ModelCatalog {
    pub fn new(path: PathBuf) -> Self {
        let state = std::fs::read(&path)
            .ok()
            .and_then(|bytes| load_cache(&bytes))
            .unwrap_or_else(|| {
                let mut snapshot: Value =
                    serde_json::from_str(SNAPSHOT).expect("embedded metadata snapshot");
                let (providers, digest) = compact_providers(snapshot["providers"].take())
                    .expect("embedded provider tree");
                CatalogData {
                    providers,
                    digest,
                    fetched_at: 0,
                    source: "snapshot".into(),
                    last_error: None,
                }
            });
        Self {
            state: RwLock::new(state),
            gate: Mutex::new(()),
            path,
            attempts: 0.into(),
            blocked: false.into(),
            cancel: RwLock::new(tokio_util::sync::CancellationToken::new()),
        }
    }
    pub fn configure_network_policy(&self, blocked: bool) {
        if self
            .blocked
            .swap(blocked, std::sync::atomic::Ordering::SeqCst)
            != blocked
        {
            let mut cancel = self.cancel.write().unwrap();
            cancel.cancel();
            *cancel = tokio_util::sync::CancellationToken::new();
        }
    }
    pub fn get(&self) -> CatalogData {
        self.state.read().unwrap().clone()
    }
    pub async fn refresh(
        &self,
        proxy: Result<Option<String>, String>,
        blocked: bool,
        force: bool,
        url: &str,
    ) -> CatalogData {
        if blocked || self.blocked.load(std::sync::atomic::Ordering::SeqCst) {
            return self.get();
        }
        let before = self.attempts.load(std::sync::atomic::Ordering::SeqCst);
        let _guard = self.gate.lock().await;
        let current = self.get();
        if self.blocked.load(std::sync::atomic::Ordering::SeqCst) {
            return current;
        }
        let cancel = self.cancel.read().unwrap().clone();
        if self.attempts.load(std::sync::atomic::Ordering::SeqCst) != before
            || (!force
                && current.fetched_at > 0
                && now().saturating_sub(current.fetched_at)
                    < super::opencode_go::catalog::TTL_SECONDS)
        {
            return current;
        }
        let fetch = async {
            let proxy = proxy?;
            let client =
                super::opencode_go::client(proxy.as_deref(), 10).map_err(|e| e.to_string())?;
            let response = client
                .get(url)
                .send()
                .await
                .map_err(|e| format!("Metadata request: {}", e.without_url()))?;
            let status = response.status();
            if !status.is_success() {
                return Err(format!("Metadata HTTP {status}"));
            }
            let providers: Value = response
                .json()
                .await
                .map_err(|_| "Invalid metadata JSON".to_string())?;
            compact_providers(providers).ok_or_else(|| "Invalid metadata provider tree".to_string())
        };
        let result = tokio::select! {
            biased;
            _ = cancel.cancelled() => Err("Metadata refresh cancelled by AI network policy".into()),
            result = fetch => result,
        };
        self.attempts
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        match result {
            Ok((providers, digest)) => {
                let next = CatalogData {
                    providers,
                    digest,
                    fetched_at: now(),
                    source: "live".into(),
                    last_error: None,
                };
                if let Some(parent) = self.path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let write = serde_json::to_vec(&next)
                    .map_err(|e| e.to_string())
                    .and_then(|b| {
                        std::fs::write(self.path.with_extension("tmp"), b)
                            .map_err(|e| e.to_string())
                    })
                    .and_then(|_| {
                        std::fs::rename(self.path.with_extension("tmp"), &self.path)
                            .map_err(|e| e.to_string())
                    });
                let mut state = self.state.write().unwrap();
                if state.digest != next.digest {
                    state.providers = next.providers;
                    state.digest = next.digest;
                }
                state.fetched_at = next.fetched_at;
                state.source = next.source;
                state.last_error = write.err().map(|e| format!("Metadata cache write: {e}"));
            }
            Err(error) => self.state.write().unwrap().last_error = Some(error),
        }
        self.get()
    }
}
pub fn shared() -> Arc<ModelCatalog> {
    static SERVICE: std::sync::OnceLock<Arc<ModelCatalog>> = std::sync::OnceLock::new();
    SERVICE
        .get_or_init(|| {
            Arc::new(ModelCatalog::new(
                crate::ai::config::default_ai_config_path().with_file_name("model-catalog.json"),
            ))
        })
        .clone()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_cache_roundtrips_and_reads_share_the_compact_catalog() {
        let providers = serde_json::json!({
            "z": {"models": {"b": {"cost": 0.5}, "a": {}}},
            "a": {"models": {}, "name": "α"}
        });
        let digest = hex::encode(Sha256::digest(serde_json::to_vec(&providers).unwrap()));
        let mut legacy = serde_json::json!({
            "providers": providers, "fetched_at": 42, "source": "live",
            "last_error": "old error", "digest": digest
        });
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("model-catalog.json");
        std::fs::write(&path, serde_json::to_vec_pretty(&legacy).unwrap()).unwrap();
        let cache = ModelCatalog::new(path.clone());
        let first = cache.get();
        assert!(Arc::ptr_eq(&first.providers, &cache.get().providers));
        assert_eq!(first.source, "cache");
        assert_eq!(first.fetched_at, 42);
        assert_eq!(first.last_error, None);
        assert_eq!(first.digest, digest);
        assert_eq!(first.provider("z"), providers["z"]);
        assert_eq!(first.provider("absent"), Value::Null);
        let encoded: Value = serde_json::from_slice(&serde_json::to_vec(&first).unwrap()).unwrap();
        assert_eq!(encoded["providers"], providers);
        legacy["providers"]["z"]["models"]["b"]["cost"] = 1.into();
        std::fs::write(&path, serde_json::to_vec(&legacy).unwrap()).unwrap();
        assert_eq!(ModelCatalog::new(path).get().source, "snapshot");
    }

    #[tokio::test]
    async fn policy_change_cancels_in_flight_and_blocks_new_requests() {
        let path = std::env::temp_dir().join(format!("metadata-{}.json", uuid::Uuid::new_v4()));
        let catalog = Arc::new(ModelCatalog::new(path));
        let original = catalog.get().digest;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let pending = {
            let catalog = catalog.clone();
            let url = url.clone();
            tokio::spawn(async move { catalog.refresh(Ok(None), false, true, &url).await })
        };
        let (_socket, _) =
            tokio::time::timeout(std::time::Duration::from_secs(1), listener.accept())
                .await
                .unwrap()
                .unwrap();
        catalog.configure_network_policy(true);
        let cancelled = pending.await.unwrap();
        assert_eq!(cancelled.digest, original);
        assert!(cancelled.last_error.unwrap().contains("cancelled"));
        let before = catalog.attempts.load(std::sync::atomic::Ordering::SeqCst);
        catalog.refresh(Ok(None), false, true, &url).await;
        assert_eq!(
            catalog.attempts.load(std::sync::atomic::Ordering::SeqCst),
            before
        );
        catalog.configure_network_policy(false);
    }
    #[tokio::test]
    async fn shared_refresh_deduplicates_digest_cache_and_failure() {
        use crate::llm::opencode_go::test_gateway;
        let path = std::env::temp_dir().join(format!("metadata-{}.json", uuid::Uuid::new_v4()));
        let catalog = ModelCatalog::new(path.clone());
        let (base, requests, task) = test_gateway::start(2, |_| {
            (
                200,
                serde_json::json!({"anthropic":{"models":{"m":{"name":"Model"}}}}).to_string(),
                "application/json",
            )
        })
        .await;
        let (a, b) = tokio::join!(
            catalog.refresh(Ok(None), false, true, &base),
            catalog.refresh(Ok(None), false, true, &base)
        );
        assert_eq!(a.digest, b.digest);
        assert_eq!(requests.lock().unwrap().len(), 1);
        assert_eq!(
            catalog.refresh(Ok(None), false, false, &base).await.digest,
            a.digest
        );
        assert_eq!(requests.lock().unwrap().len(), 1);
        assert_eq!(
            catalog.refresh(Ok(None), false, true, &base).await.digest,
            a.digest
        );
        task.await.unwrap();
        let loaded = ModelCatalog::new(path.clone());
        assert_eq!(loaded.get().source, "cache");
        assert_eq!(loaded.get().digest, a.digest);
        let fail = catalog
            .refresh(Err("proxy unavailable".into()), false, true, &base)
            .await;
        assert_eq!(fail.digest, a.digest);
        assert_eq!(fail.last_error.as_deref(), Some("proxy unavailable"));
        std::fs::remove_file(path).unwrap();
    }
    #[tokio::test]
    async fn corrupt_cache_policy_proxy_and_subtrees() {
        let path = std::env::temp_dir().join(format!("metadata-{}.json", uuid::Uuid::new_v4()));
        std::fs::write(&path, "{}").unwrap();
        let catalog = ModelCatalog::new(path.clone());
        for key in [
            "deepseek",
            "agnes",
            "anthropic",
            "groq",
            "zhipuai",
            "siliconflow",
            "siliconflow-cn",
        ] {
            assert!(catalog.get().provider(key)["models"].is_object());
        }
        assert!(
            catalog
                .refresh(Err("bad proxy".into()), true, true, "http://127.0.0.1:1")
                .await
                .last_error
                .is_none()
        );
        assert_eq!(
            catalog
                .refresh(Err("bad proxy".into()), false, true, "http://127.0.0.1:1")
                .await
                .last_error
                .as_deref(),
            Some("bad proxy")
        );
        std::fs::remove_file(path).unwrap();
    }
}
