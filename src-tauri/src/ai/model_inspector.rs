//! Inspector DTO assembly and non-configuration persistence; no credential ownership.
use crate::llm::{model_catalog, opencode_go::catalog::{GoCatalogDto, valid_protocol}};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::{BTreeMap, BTreeSet, HashMap}, path::Path, sync::Mutex};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckResult {
    pub ok: bool,
    pub latency_ms: Option<u64>,
    pub error: Option<String>,
    pub checked_at: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InspectorRow {
    pub id: String,
    pub name: String,
    pub protocol: String,
    pub protocol_source: Option<String>,
    pub context_limit: Option<u64>,
    pub output_limit: Option<u64>,
    pub input_modalities: Option<Vec<String>>,
    pub output_modalities: Option<Vec<String>>,
    pub tool_call: Option<bool>,
    pub reasoning: Option<bool>,
    pub cost: Value,
    pub status: Option<String>,
    pub metadata_source: String,
    pub live_exists: Option<bool>,
    pub current: bool,
    pub check: Option<CheckResult>,
}
#[derive(Debug, Clone, Serialize)]
pub struct ProviderModelsDto {
    pub rows: Vec<InspectorRow>,
    pub fetched_at: u64,
    pub source: String,
    pub last_error: Option<String>,
    pub unavailable: bool,
    pub checks_disabled: bool,
}
pub fn provider_key<'a>(id: &'a str, base: &str) -> &'a str {
    match id {
        "glm" => "zhipuai",
        "siliconflow" => if reqwest::Url::parse(base).ok().and_then(|u| u.host_str().map(str::to_owned))
            .as_deref() == Some("api.siliconflow.cn") { "siliconflow-cn" } else { "siliconflow" },
        _ => id,
    }
}
pub fn protocol(runtime: &str) -> &str {
    match runtime {
        "openai-compat" | "llama-server" | "ollama" => "chat",
        "anthropic" => "messages",
        _ => runtime,
    }
}
pub fn is_local(runtime: &str) -> bool { matches!(runtime, "llama-server" | "ollama") }
pub fn checks_disabled(runtime: &str, full_local: bool, fully_disabled: bool) -> bool {
    fully_disabled || (full_local && !is_local(runtime))
}
fn modalities(value: &Value) -> Option<Vec<String>> {
    value.as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect())
}
pub fn assemble(current: &str, runtime: &str, subtree: &Value, live: Option<&[String]>, aliases: &Value) -> Vec<InspectorRow> {
    let local = is_local(runtime);
    let mut ids = BTreeSet::new();
    if local {
        ids.extend(live.unwrap_or_default().iter().cloned());
    } else {
        if let Some(models) = subtree["models"].as_object() { ids.extend(models.keys().cloned()); }
        if !current.is_empty() { ids.insert(current.to_string()); }
    }
    let mut rows = ids.into_iter().map(|id| {
        let exact = &subtree["models"][&id];
        let alias = &subtree["models"][aliases[&id]["target_id"].as_str().unwrap_or("")];
        let (meta, source) = if local { (&Value::Null, "live") }
            else if exact.is_object() { (exact, "catalog") }
            else if alias.is_object() && aliases[&id]["checked_at"].is_string() { (alias, "alias") }
            else { (&Value::Null, "unlisted") };
        InspectorRow {
            name: meta["name"].as_str().unwrap_or(&id).into(), current: id == current,
            protocol: protocol(runtime).into(), protocol_source: None,
            context_limit: meta["limit"]["context"].as_u64(), output_limit: meta["limit"]["output"].as_u64(),
            input_modalities: modalities(&meta["modalities"]["input"]), output_modalities: modalities(&meta["modalities"]["output"]),
            tool_call: meta["tool_call"].as_bool(), reasoning: meta["reasoning"].as_bool(),
            cost: meta["cost"].clone(), status: meta["status"].as_str().map(str::to_owned),
            metadata_source: source.into(), live_exists: live.map(|ids| ids.contains(&id)),
            check: None, id,
        }
    }).collect::<Vec<_>>();
    rows.sort_by(|a, b| b.current.cmp(&a.current).then_with(|| a.id.cmp(&b.id)));
    rows
}
pub fn go_rows(dto: &GoCatalogDto, current: &str, overrides: &HashMap<String, String>) -> Vec<InspectorRow> {
    let mut rows = dto.models.iter().map(|m| InspectorRow {
        id: m.id.clone(), name: m.name.clone(), current: m.id == current,
        protocol: overrides.get(&m.id).map(|p| valid_protocol(p)).unwrap_or(&m.protocol).into(),
        protocol_source: Some(if overrides.contains_key(&m.id) { "user_override".into() } else { m.protocol_source.clone() }),
        context_limit: m.context_limit, output_limit: m.output_limit,
        input_modalities: (!m.input_modalities.is_empty()).then(|| m.input_modalities.clone()),
        // Go DTO does not yet carry output modalities; never fabricate them.
        output_modalities: None, tool_call: Some(m.tool_call), reasoning: Some(m.reasoning),
        cost: m.cost.clone(), status: m.status.clone(), metadata_source: if m.protocol_source == "default" { "unlisted" } else { "catalog" }.into(),
        live_exists: None, check: None,
    }).collect::<Vec<_>>();
    rows.sort_by(|a, b| b.current.cmp(&a.current).then_with(|| a.id.cmp(&b.id)));
    rows
}
pub async fn live_models(base: &str, key: &str, proxy: Option<&str>) -> Result<Vec<String>, String> {
    let client = crate::llm::opencode_go::client(proxy, 10).map_err(|e| e.to_string())?;
    let response = client.get(format!("{}/models", base.trim_end_matches('/'))).bearer_auth(key)
        .send().await.map_err(|e| format!("Model list: {}", e.without_url()))?;
    if !response.status().is_success() { return Err(format!("Model list HTTP {}", response.status())); }
    let data: Value = response.json().await.map_err(|_| "Invalid model list JSON".to_string())?;
    let entries = data["data"].as_array().ok_or_else(|| "Invalid model list: missing data array".to_string())?;
    entries.iter().map(|m| m["id"].as_str().filter(|id| !id.is_empty()).map(str::to_owned)
        .ok_or_else(|| "Invalid model list: missing model ID".to_string())).collect()
}
pub type CheckResults = BTreeMap<String, BTreeMap<String, CheckResult>>;
static RESULTS_GATE: Mutex<()> = Mutex::new(());
pub fn read_results(path: &Path) -> CheckResults {
    std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}
pub fn save_result(path: &Path, provider: &str, model: &str, result: CheckResult) -> Result<(), String> {
    let _guard = RESULTS_GATE.lock().map_err(|e| e.to_string())?;
    let mut results = read_results(path);
    results.entry(provider.into()).or_default().insert(model.into(), result);
    if let Some(parent) = path.parent() { std::fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
    let temp = path.with_extension("tmp");
    std::fs::write(&temp, serde_json::to_vec(&results).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, path).map_err(|e| e.to_string())
}
pub fn attach_results(rows: &mut [InspectorRow], provider: &str, path: &Path) {
    let results = read_results(path);
    for row in rows { row.check = results.get(provider).and_then(|m| m.get(&row.id)).cloned(); }
}
pub fn check_result(ok: bool, latency_ms: u64, error: Option<String>) -> CheckResult {
    CheckResult { ok, latency_ms: Some(latency_ms), error, checked_at: model_catalog::now() }
}
pub async fn probe(llm: &dyn crate::llm::Llm, deadline: Option<std::time::Duration>) -> (bool, String, u64) {
    let start = std::time::Instant::now();
    let req = crate::llm::ChatRequest::simple("You are a test assistant.", "Reply with exactly: pong");
    let call = llm.chat(req);
    let result = match deadline {
        Some(duration) => match tokio::time::timeout(duration, call).await {
            Ok(result) => result,
            Err(_) => return (false, "Model check timed out".into(), start.elapsed().as_millis() as u64),
        },
        None => call.await,
    };
    let elapsed = start.elapsed().as_millis() as u64;
    match result {
        Ok(response) => (true, response.content, elapsed),
        Err(error) => (false, error.to_string(), elapsed),
    }
}
pub async fn guarded_probe(llm: &dyn crate::llm::Llm, blocked: bool, deadline: Option<std::time::Duration>) -> Result<(bool, String, u64), String> {
    if blocked { return Err("Model checks are disabled by the AI network policy".into()); }
    Ok(probe(llm, deadline).await)
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[tokio::test]
    async fn gateway_success_error_timeout_and_disabled_zero_requests() {
        use crate::llm::{openai_compat::OpenAiCompatProvider, opencode_go::test_gateway};
        let (base, requests, task) = test_gateway::start(3, |raw| {
            if raw.starts_with("GET /models") {
                (200, json!({"data":[{"id":"loaded"}]}).to_string(), "application/json")
            } else if raw.contains("\"bad\"") {
                (401, "Original unauthorized\nFull detail".into(), "text/plain")
            } else {
                (200, json!({"choices":[{"message":{"role":"assistant","content":"pong"}}]}).to_string(), "application/json")
            }
        }).await;
        let provider = OpenAiCompatProvider::new("unit", &base, "fixture-key", "good")
            .with_go_client(crate::llm::opencode_go::client(None, 1).unwrap(), Default::default());
        assert!(guarded_probe(&provider, true, None).await.is_err());
        assert!(requests.lock().unwrap().is_empty());
        assert_eq!(live_models(&base, "fixture-key", None).await.unwrap(), ["loaded"]);
        let (ok, message, _) = guarded_probe(&provider, false, None).await.unwrap();
        assert!(ok);
        assert_eq!(message, "pong");
        let bad = OpenAiCompatProvider::new("unit", &base, "fixture-key", "bad")
            .with_go_client(crate::llm::opencode_go::client(None, 1).unwrap(), Default::default());
        let (ok, message, _) = probe(&bad, None).await;
        assert!(!ok);
        assert!(message.contains("Original unauthorized\nFull detail"));
        task.await.unwrap();
        assert!(requests.lock().unwrap()[0].to_lowercase().contains("authorization: bearer fixture-key"));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let slow = OpenAiCompatProvider::new("unit", format!("http://{}", listener.local_addr().unwrap()), "", "slow")
            .with_go_client(crate::llm::opencode_go::client(None, 1).unwrap(), Default::default());
        let hold = tokio::spawn(async move {
            let (_socket, _) = listener.accept().await.unwrap();
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        });
        let (ok, message, _) = probe(&slow, Some(std::time::Duration::from_millis(20))).await;
        assert!(!ok);
        assert_eq!(message, "Model check timed out");
        hold.abort();
    }
    #[test]
    fn precise_alias_unknown_live_difference_and_local_authority() {
        let subtree = json!({"models":{"canonical":{"name":"Canonical","limit":{"context":123,"output":45},
            "modalities":{"input":["text","image"],"output":["text"]},"tool_call":false,"reasoning":true,"cost":{"input":0},"status":"deprecated"}}});
        let aliases = json!({"deepseek-chat":{"target_id":"canonical","checked_at":"2026-10-15"}});
        let rows = assemble("deepseek-chat", "openai-compat", &subtree, Some(&["deepseek-chat".into(), "outsider".into()]), &aliases);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].metadata_source, "alias");
        assert_eq!(rows[0].context_limit, Some(123));
        assert_eq!(rows[1].live_exists, Some(false));
        assert_eq!(rows[1].metadata_source, "catalog");
        assert_eq!(rows[1].tool_call, Some(false));
        let missing = assemble("Qwen2.5-Coder", "unknown", &subtree, None, &Value::Null);
        assert_eq!(missing[0].metadata_source, "unlisted");
        assert_eq!(missing[0].context_limit, None);
        assert_eq!(missing[0].tool_call, None);
        assert_eq!(missing[0].protocol, "unknown");
        let local = assemble("configured", "llama-server", &subtree, Some(&["loaded".into()]), &aliases);
        assert_eq!(local.len(), 1);
        assert_eq!(local[0].id, "loaded");
        assert_eq!(local[0].metadata_source, "live");
        assert!(assemble("configured", "llama-server", &subtree, None, &aliases).is_empty());
        assert_eq!(provider_key("glm", ""), "zhipuai");
        assert_eq!(provider_key("siliconflow", "https://api.siliconflow.cn/v1"), "siliconflow-cn");
        assert_eq!(provider_key("siliconflow", "https://evilapi.siliconflow.cn/v1"), "siliconflow");
        assert_eq!(protocol("anthropic"), "messages");
    }
    #[test]
    fn persistence_merges_corruption_and_network_policy() {
        let path = std::env::temp_dir().join(format!("checks-{}.json", uuid::Uuid::new_v4()));
        std::fs::write(&path, "broken").unwrap();
        assert!(read_results(&path).is_empty());
        save_result(&path, "a", "x:y", check_result(true, 12, None)).unwrap();
        save_result(&path, "b", "x", check_result(false, 30, Some("401 original\nfull error".into()))).unwrap();
        let results = read_results(&path);
        assert_eq!(results["a"]["x:y"].latency_ms, Some(12));
        assert_eq!(results["b"]["x"].error.as_deref(), Some("401 original\nfull error"));
        assert!(checks_disabled("anthropic", true, false));
        assert!(!checks_disabled("llama-server", true, false));
        assert!(checks_disabled("llama-server", false, true));
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn go_agrees_with_catalog_and_override() {
        let service = crate::llm::opencode_go::catalog::CatalogService::new(
            std::env::temp_dir().join(format!("go-{}.json", uuid::Uuid::new_v4())));
        let dto = service.get();
        let overrides = HashMap::from([(dto.models[0].id.clone(), "messages".into())]);
        let rows = go_rows(&dto, &dto.models[0].id, &overrides);
        for model in dto.models.iter() {
            let row = rows.iter().find(|r| r.id == model.id).unwrap();
            assert_eq!(row.name, model.name);
            assert_eq!(row.context_limit, model.context_limit);
            assert_eq!(row.output_limit, model.output_limit);
            assert_eq!(row.cost, model.cost);
            assert_eq!(row.status, model.status);
            assert_eq!(row.protocol, overrides.get(&model.id).unwrap_or(&model.protocol).as_str());
            assert_eq!(row.protocol_source.as_deref(), Some(if overrides.contains_key(&model.id) { "user_override" } else { &model.protocol_source }));
        }
    }
}
