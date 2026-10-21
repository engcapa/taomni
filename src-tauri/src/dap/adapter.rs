use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;

/// How the kernel reaches a debug adapter. `Stdio` spawns a process and speaks DAP
/// over its stdin/stdout; `Tcp` connects to an already-listening adapter (java-debug
/// hands back a port via jdtls, so the Java adapter, D2, will use `Tcp`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DapTransport {
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        cwd: Option<String>,
    },
    Tcp {
        #[serde(default = "default_host")]
        host: String,
        port: u16,
    },
    /// Spawn an adapter-owned TCP server, substitute `${port}` in its argv,
    /// wait until it accepts connections, and retain the child for cleanup.
    ManagedTcp {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        cwd: Option<String>,
        #[serde(default = "default_host")]
        host: String,
        #[serde(default = "default_ready_timeout_ms")]
        ready_timeout_ms: u64,
    },
}

pub(super) fn default_host() -> String {
    "127.0.0.1".to_string()
}

pub(super) fn default_ready_timeout_ms() -> u64 {
    10_000
}
/// The kernel's plan for reaching + launching a debuggee, produced by an adapter
/// from a launch config. `transport` says how to connect; `request` +
/// `arguments` are the resolved `launch`/`attach` payload the client sends after
/// `initialize` (the Java adapter fills these from jdtls — D2).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DapLaunchPlan {
    pub transport: DapTransport,
    /// `"launch"` or `"attach"`.
    pub request: String,
    /// Resolved launch/attach arguments (adapter-specific, opaque to the kernel).
    pub arguments: Value,
}

/// A registered debug adapter: how to reach + launch a debuggee for a given
/// config. Java (D2) is the first implementation; others (Node/Go/LLDB) plug in
/// the same way. `resolve` is async because language adapters may need to talk to
/// their language server first (jdtls hands java-debug a port).
#[async_trait::async_trait]
pub trait DebugAdapter: Send + Sync {
    /// Stable adapter id (e.g. `"java"`), matched against `dap_start_session`.
    fn id(&self) -> &str;

    /// Resolve transport + launch/attach payload from a launch config.
    async fn resolve(&self, launch_config: &Value) -> Result<DapLaunchPlan, String>;
}

/// Registry of debug adapters, keyed by id — analogous to `lsp_presets`. Empty in
/// D1; the Java adapter is inserted in D2.
#[derive(Default)]
pub struct DebugAdapterRegistry {
    pub(super) adapters: HashMap<String, Arc<dyn DebugAdapter>>,
}

impl DebugAdapterRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, adapter: Arc<dyn DebugAdapter>) {
        self.adapters.insert(adapter.id().to_string(), adapter);
    }

    pub fn get(&self, id: &str) -> Option<Arc<dyn DebugAdapter>> {
        self.adapters.get(id).cloned()
    }
}

/// Resolver for adapters whose executable and launch payload were produced by
/// the trusted workspace execution provider. The adapter id remains registered
/// explicitly, so arbitrary ids cannot spawn a process through DAP IPC.
pub(super) struct ConfiguredDebugAdapter {
    pub(super) id: &'static str,
}

impl ConfiguredDebugAdapter {
    pub(super) fn new(id: &'static str) -> Self {
        Self { id }
    }
}

#[async_trait::async_trait]
impl DebugAdapter for ConfiguredDebugAdapter {
    fn id(&self) -> &str {
        self.id
    }

    async fn resolve(&self, launch_config: &Value) -> Result<DapLaunchPlan, String> {
        let command = launch_config
            .get("adapterCommand")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                format!(
                    "No executable was configured for the `{}` debug adapter",
                    self.id
                )
            })?;
        let cwd = launch_config
            .get("adapterCwd")
            .and_then(Value::as_str)
            .map(str::to_string);
        let request = launch_config
            .get("request")
            .and_then(Value::as_str)
            .unwrap_or("launch")
            .to_string();
        if request != "launch" && request != "attach" {
            return Err(format!("Unsupported DAP request `{request}`"));
        }
        let mut arguments = launch_config
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let mode = launch_config
            .get("mode")
            .cloned()
            .unwrap_or_else(|| json!({ "kind": "stdio" }));
        let kind = mode.get("kind").and_then(Value::as_str).unwrap_or("stdio");
        let transport = match kind {
            "stdio" => DapTransport::Stdio {
                command: command.to_string(),
                args: string_array(mode.get("args"))?,
                cwd,
            },
            "managedTcp" => DapTransport::ManagedTcp {
                command: command.to_string(),
                args: string_array(mode.get("args"))?,
                cwd,
                host: "127.0.0.1".to_string(),
                ready_timeout_ms: default_ready_timeout_ms(),
            },
            "cargo" if self.id == "lldb" => {
                let executable = resolve_cargo_debug_artifact(&mode, cwd.as_deref()).await?;
                arguments["program"] = json!(executable);
                DapTransport::Stdio {
                    command: command.to_string(),
                    args: Vec::new(),
                    cwd,
                }
            }
            "swift" if self.id == "lldb" => {
                let executable = resolve_swift_debug_artifact(&mode, cwd.as_deref()).await?;
                arguments["program"] = json!(executable);
                DapTransport::Stdio {
                    command: command.to_string(),
                    args: Vec::new(),
                    cwd,
                }
            }
            _ => return Err(format!("Unsupported `{}` transport mode `{kind}`", self.id)),
        };
        Ok(DapLaunchPlan {
            transport,
            request,
            arguments,
        })
    }
}

pub(super) fn string_array(value: Option<&Value>) -> Result<Vec<String>, String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| {
                    item.as_str()
                        .map(str::to_string)
                        .ok_or_else(|| "debug adapter args must be strings".to_string())
                })
                .collect()
        })
        .unwrap_or_else(|| Ok(Vec::new()))
}

pub(super) async fn command_output(
    executable: &str,
    args: &[String],
    cwd: Option<&str>,
    operation: &str,
) -> Result<std::process::Output, String> {
    let mut command = tokio::process::Command::new(executable);
    command
        .args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let output = tokio::time::timeout(std::time::Duration::from_secs(180), command.output())
        .await
        .map_err(|_| format!("{operation} timed out after 180s"))?
        .map_err(|error| format!("failed to start `{executable}` for {operation}: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!(
            "{operation} failed with {}{}",
            output.status,
            if stderr.is_empty() {
                String::new()
            } else {
                format!(": {stderr}")
            }
        ));
    }
    Ok(output)
}

pub(super) async fn resolve_cargo_debug_artifact(
    mode: &Value,
    cwd: Option<&str>,
) -> Result<String, String> {
    let command = mode
        .get("command")
        .and_then(Value::as_str)
        .unwrap_or("cargo");
    let args = string_array(mode.get("args"))?;
    let target_name = mode.get("targetName").and_then(Value::as_str);
    let output = command_output(command, &args, cwd, "Cargo pre-launch build").await?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut executable = None;
    for line in stdout.lines() {
        let Ok(message) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if message.get("reason").and_then(Value::as_str) != Some("compiler-artifact") {
            continue;
        }
        if target_name.is_some()
            && message.pointer("/target/name").and_then(Value::as_str) != target_name
        {
            continue;
        }
        if let Some(path) = message.get("executable").and_then(Value::as_str) {
            executable = Some(path.to_string());
        }
    }
    executable.ok_or_else(|| "Cargo completed but did not report an executable compiler artifact for the selected target".to_string())
}

pub(super) async fn resolve_swift_debug_artifact(
    mode: &Value,
    cwd: Option<&str>,
) -> Result<String, String> {
    let command = mode
        .get("command")
        .and_then(Value::as_str)
        .unwrap_or("swift");
    let product = mode
        .get("product")
        .and_then(Value::as_str)
        .ok_or("Swift debug configuration has no executable product")?;
    command_output(
        command,
        &[
            "build".to_string(),
            "--configuration".to_string(),
            "debug".to_string(),
        ],
        cwd,
        "Swift pre-launch build",
    )
    .await?;
    let output = command_output(
        command,
        &["build".to_string(), "--show-bin-path".to_string()],
        cwd,
        "Swift product resolution",
    )
    .await?;
    let bin_path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if bin_path.is_empty() {
        return Err("SwiftPM returned an empty binary path".to_string());
    }
    let executable = std::path::Path::new(&bin_path).join(product);
    if !executable.is_file() {
        return Err(format!(
            "SwiftPM did not produce `{}` at {}",
            product,
            executable.display()
        ));
    }
    Ok(executable.to_string_lossy().to_string())
}
