use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;

#[derive(Deserialize, schemars::JsonSchema, Default)]
pub(super) struct SessionListParams {
    #[serde(default)]
    pub(super) query: Option<String>,
    #[serde(default)]
    pub(super) session_type: Option<String>,
    #[serde(default)]
    pub(super) group_path: Option<String>,
}

#[derive(Deserialize, Serialize, schemars::JsonSchema)]
pub(super) struct SessionIdParams {
    pub(super) session_id: String,
}

#[derive(Deserialize, Serialize, schemars::JsonSchema)]
pub(super) struct SessionCreateParams {
    #[serde(default)]
    pub(super) id: Option<String>,
    pub(super) name: String,
    pub(super) session_type: String,
    #[serde(default)]
    pub(super) group_path: Option<String>,
    #[serde(default)]
    pub(super) host: Option<String>,
    #[serde(default)]
    pub(super) port: Option<u16>,
    #[serde(default)]
    pub(super) username: Option<String>,
    #[serde(default)]
    pub(super) auth: Option<SessionAuthParams>,
    #[serde(default)]
    pub(super) options: Option<Value>,
}

#[derive(Deserialize, Serialize, schemars::JsonSchema)]
pub(super) struct SessionUpdateParams {
    pub(super) session_id: String,
    #[serde(default)]
    pub(super) name: Option<String>,
    #[serde(default)]
    pub(super) session_type: Option<String>,
    #[serde(default)]
    pub(super) group_path: Option<String>,
    #[serde(default)]
    pub(super) host: Option<String>,
    #[serde(default)]
    pub(super) port: Option<u16>,
    #[serde(default)]
    pub(super) username: Option<String>,
    #[serde(default)]
    pub(super) auth: Option<SessionAuthParams>,
    #[serde(default)]
    pub(super) options: Option<Value>,
}

#[derive(Deserialize, schemars::JsonSchema, Serialize)]
pub(super) struct SessionAuthParams {
    /// none | agent | private_key | password_ref. Plaintext passwords are not accepted.
    pub(super) method: String,
    #[serde(default)]
    pub(super) private_key_path: Option<String>,
    #[serde(default)]
    pub(super) password_ref: Option<String>,
}

#[derive(Deserialize, Serialize, schemars::JsonSchema)]
pub(super) struct SessionDuplicateParams {
    pub(super) session_id: String,
    #[serde(default)]
    pub(super) name: Option<String>,
}

#[derive(Deserialize, Serialize, schemars::JsonSchema)]
pub(super) struct SessionMoveGroupParams {
    pub(super) session_id: String,
    #[serde(default)]
    pub(super) group_path: Option<String>,
}

#[derive(Deserialize, Serialize, schemars::JsonSchema)]
pub(super) struct GroupPathParams {
    pub(super) path: String,
}

#[derive(Deserialize, Serialize, schemars::JsonSchema)]
pub(super) struct GroupRenameParams {
    pub(super) old_path: String,
    pub(super) new_path: String,
}

#[derive(Deserialize, Serialize, schemars::JsonSchema)]
pub(super) struct GroupDeleteParams {
    pub(super) path: String,
    /// false clears affected sessions' group_path; true deletes affected sessions too.
    #[serde(default)]
    pub(super) delete_sessions: bool,
}

#[derive(Deserialize, schemars::JsonSchema, Serialize)]
pub(super) struct SessionOpenParams {
    #[serde(default)]
    pub(super) session_id: Option<String>,
    #[serde(default)]
    pub(super) query: Option<String>,
    /// Optional override for saved LocalShell sessions. Use local_shell.type to
    /// choose the local terminal kind; non-local saved sessions reject this.
    #[serde(default)]
    pub(super) local_shell: Option<LocalShellParams>,
}

#[derive(Deserialize, schemars::JsonSchema, Serialize)]
pub(super) struct SessionOpenEditorParams {
    #[serde(default)]
    pub(super) session_id: Option<String>,
    #[serde(default)]
    pub(super) session_type: Option<String>,
    #[serde(default)]
    pub(super) group_path: Option<String>,
}

#[derive(Deserialize, schemars::JsonSchema, Serialize)]
pub(super) struct QuickConnectParams {
    pub(super) input: String,
}

#[derive(Deserialize, schemars::JsonSchema, Serialize, Default)]
pub(super) struct EmptyParams {}

#[derive(Deserialize, schemars::JsonSchema, Serialize, Clone, Debug, Default)]
pub(super) struct LocalShellParams {
    /// Local shell type. Windows accepts: default, cmd/command-prompt,
    /// powershell/powershell7/pwsh, windows-powershell, git-bash, wsl. Unix
    /// accepts: default, bash, zsh, sh. Use custom with path for an explicit
    /// executable.
    #[serde(rename = "type", alias = "shell", default)]
    pub(super) shell_type: Option<String>,
    /// Explicit executable path, required when type is custom. For WSL, prefer
    /// type=wsl and pass distro/user options through args.
    #[serde(default)]
    pub(super) path: Option<String>,
    /// Extra argv passed to the shell. Examples: WSL ["-d","Ubuntu"],
    /// PowerShell ["-NoLogo"], Git Bash ["--login","-i"].
    #[serde(default)]
    pub(super) args: Option<Vec<String>>,
    /// Optional display name for the opened terminal tab.
    #[serde(default)]
    pub(super) name: Option<String>,
}

#[derive(Deserialize, schemars::JsonSchema, Serialize)]
pub(super) struct TabIdParams {
    pub(super) tab_id: String,
}

#[derive(Deserialize, schemars::JsonSchema, Serialize)]
pub(super) struct TabRenameParams {
    pub(super) tab_id: String,
    pub(super) title: String,
}

#[derive(Deserialize, schemars::JsonSchema, Serialize)]
pub(super) struct TabMoveParams {
    pub(super) tab_id: String,
    pub(super) to_index: usize,
}

#[derive(Deserialize, schemars::JsonSchema, Serialize)]
pub(super) struct OpenLocalTerminalParams {
    #[serde(default)]
    pub(super) title: Option<String>,
    /// Select which local shell to launch, for example
    /// {"type":"cmd"}, {"type":"powershell7"}, {"type":"git-bash"},
    /// {"type":"wsl","args":["-d","Ubuntu"]}, or
    /// {"type":"custom","path":"C:\\tools\\nu.exe"}.
    #[serde(default)]
    pub(super) local_shell: Option<LocalShellParams>,
}

#[derive(Deserialize, schemars::JsonSchema, Serialize)]
pub(super) struct OpenFileBrowserParams {
    pub(super) path: String,
    #[serde(default)]
    pub(super) title: Option<String>,
}
