use super::*;

pub(super) fn lsp_initialization_options(
    preset: &LspServerPreset,
    command: &LspServerCommandPreset,
    sdk_environment: &WorkspaceSdkEnvironment,
) -> Value {
    if preset.id == "scala" {
        // Metals emits jar: locations for standard-library/dependency sources
        // only when the client promises it can resolve virtual documents.
        return json!({ "isVirtualDocumentSupported": true });
    }
    if !command_is_jdtls(command) {
        return Value::Null;
    }
    let runtimes: &[JavaRuntimeConfiguration] = &sdk_environment.java_runtimes;
    let java_settings = get_configured_java_settings().to_java_settings(runtimes);
    let mut options = json!({
        "settings": {
            "java": java_settings
        },
        // JDT LS drops every location that resolves into a `.class` file unless the
        // client declares `classFileContentsSupport` (JDTUtils#toUri(IClassFile)
        // returns null otherwise). Without it, Ctrl+click on a JDK or dependency
        // type silently resolves to nothing. It also widens workspace symbol search
        // to application/system libraries and enables decompiled-source lookups.
        "extendedClientCapabilities": {
            "classFileContentsSupport": true
        }
    });
    // Load configured jdtls extension bundles (java-debug / java-test) so
    // debugging + testing become available (M8). Omitted when none are configured.
    // Lombok is NOT here — it loads as a `-javaagent`, not an OSGi bundle.
    let bundles = crate::java_bundles::configured_bundle_jars();
    if !bundles.is_empty() {
        options["bundles"] = json!(bundles);
    }
    options
}

pub(super) fn server_status(
    preset: &LspServerPreset,
    preferred_command_id: Option<&str>,
    active: bool,
    error: Option<String>,
) -> LspServerStatus {
    let command = select_available_command(preset, preferred_command_id, None);
    let binary_available = command.is_some();
    let (runtime_status, runtime_error) = if preset_uses_jdtls(preset, command.as_ref()) {
        jdtls_runtime_probe()
    } else {
        (None, None)
    };
    // jdtls is only "available" when both the wrapper/binary and a suitable
    // JDK are present — otherwise Settings green-dots a broken install.
    let available = if command.as_ref().is_some_and(command_is_jdtls) {
        binary_available && runtime_error.is_none()
    } else {
        binary_available
    };
    let error = error.or_else(|| {
        if command.as_ref().is_some_and(command_is_jdtls) {
            runtime_error
        } else if !binary_available && preset.id == "java" {
            // Binary missing: keep install_hint primary; still surface a short
            // runtime note via runtime_status only.
            None
        } else {
            None
        }
    });
    LspServerStatus {
        preset_id: preset.id.clone(),
        display_name: preset.display_name.clone(),
        document_language_ids: preset.document_language_ids.clone(),
        available,
        active,
        selected_command_id: command.as_ref().map(|cmd| cmd.id.clone()),
        selected_command: command
            .as_ref()
            .map(|cmd| command_line(&cmd.command, &cmd.args)),
        install_hint: primary_install_hint(preset).unwrap_or_default(),
        error,
        runtime_status,
        commands: preset
            .commands
            .iter()
            .map(|cmd| LspServerCommandStatus {
                id: cmd.id.clone(),
                label: cmd.label.clone(),
                command: cmd.command.clone(),
                args: cmd.args.clone(),
                install_hint: cmd.install_hint.clone(),
                fallback: cmd.fallback,
                available: command_available(&cmd.command),
            })
            .collect(),
    }
}

pub(super) fn primary_install_hint(preset: &LspServerPreset) -> Option<String> {
    preset
        .commands
        .iter()
        .find(|cmd| !cmd.fallback)
        .or_else(|| preset.commands.first())
        .map(|cmd| cmd.install_hint.clone())
}

pub(super) fn select_available_command(
    preset: &LspServerPreset,
    preferred_command_id: Option<&str>,
    custom_command: Option<&LspCustomServerCommand>,
) -> Option<LspServerCommandPreset> {
    if let Some(command) = custom_command_to_preset(custom_command) {
        return command_available(&command.command).then_some(command);
    }
    if let Some(preferred) = preferred_command_id
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        if let Some(command) = preset
            .commands
            .iter()
            .find(|cmd| cmd.id == preferred && command_available(&cmd.command))
        {
            return Some(command.clone());
        }
    }
    preset
        .commands
        .iter()
        .find(|cmd| command_available(&cmd.command))
        .cloned()
}

pub(super) fn configured_command(
    preset: &LspServerPreset,
    preferred_command_id: Option<&str>,
    custom_command: Option<&LspCustomServerCommand>,
) -> Option<LspServerCommandPreset> {
    if let Some(command) = custom_command_to_preset(custom_command) {
        return Some(command);
    }
    if let Some(preferred) = preferred_command_id
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        if let Some(command) = preset.commands.iter().find(|cmd| cmd.id == preferred) {
            return Some(command.clone());
        }
    }
    preset.commands.first().cloned()
}

pub(super) fn custom_command_to_preset(
    custom_command: Option<&LspCustomServerCommand>,
) -> Option<LspServerCommandPreset> {
    let custom = custom_command?;
    let command = custom.command.trim();
    if command.is_empty() {
        return None;
    }
    let args: Vec<String> = custom
        .args
        .iter()
        .map(|arg| arg.trim())
        .filter(|arg| !arg.is_empty())
        .map(ToString::to_string)
        .collect();
    let mut hasher = DefaultHasher::new();
    command.hash(&mut hasher);
    args.hash(&mut hasher);
    let id = format!("custom-{:x}", hasher.finish());
    let label = custom
        .label
        .as_deref()
        .map(str::trim)
        .filter(|label| !label.is_empty())
        .unwrap_or("Custom")
        .to_string();
    Some(LspServerCommandPreset {
        id,
        label,
        command: command.to_string(),
        args,
        install_hint: "Check the custom language server command".into(),
        fallback: false,
    })
}

pub(super) fn command_available(command: &str) -> bool {
    let command = command.trim();
    if command.is_empty() {
        return false;
    }
    let now = Instant::now();
    let mut cache = command_availability_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(cached) = cache.get(command)
        && now.duration_since(cached.checked_at) < COMMAND_AVAILABILITY_TTL
    {
        return cached.available;
    }
    let available = command_available_uncached(command);
    cache.insert(
        command.to_string(),
        CachedCommandAvailability {
            available,
            checked_at: now,
        },
    );
    available
}

pub(super) fn command_available_uncached(command: &str) -> bool {
    let path = Path::new(command);
    let resolved = if path.is_absolute() || command.contains('/') || command.contains('\\') {
        if !path.is_file() {
            return false;
        }
        path.to_path_buf()
    } else {
        match which::which(command) {
            Ok(resolved) => resolved,
            Err(_) => return false,
        }
    };
    // A resolved path is not proof the tool runs: rustup installs *proxy shims*
    // into `~/.cargo/bin` when rustup itself is installed, independent of which
    // components exist. `rust-analyzer.exe` is therefore always on PATH, and
    // `which` reports it available even when the component was never added — the
    // shim then fails at spawn with `error: Unknown binary 'rust-analyzer' in
    // official toolchain '…'`. That turned a missing component into a raw stderr
    // string in the editor instead of the `rustup component add` install hint.
    if is_rustup_shim(&resolved) {
        return binary_runs(&resolved);
    }
    true
}

/// Names rustup proxies out of `<cargo home>/bin` that can appear as a language
/// server command. A shim is only distinguishable from a real binary by living
/// next to rustup's own proxy, so require `rustup` as a sibling.
pub(super) const RUSTUP_SHIMMED_LSP_BINARIES: &[&str] = &["rust-analyzer"];

pub(super) fn is_rustup_shim(resolved: &Path) -> bool {
    let Some(stem) = resolved.file_stem().and_then(|stem| stem.to_str()) else {
        return false;
    };
    if !RUSTUP_SHIMMED_LSP_BINARIES
        .iter()
        .any(|name| stem.eq_ignore_ascii_case(name))
    {
        return false;
    }
    let Some(parent) = resolved.parent() else {
        return false;
    };
    parent
        .join(format!("rustup{}", std::env::consts::EXE_SUFFIX))
        .is_file()
}

/// Spawn `<binary> --version` to confirm the tool actually starts. Only used for
/// shims, so this costs one short-lived process per [`COMMAND_AVAILABILITY_TTL`]
/// window rather than on every availability query. Broken shims can block while
/// spawning or resolving their toolchain, so bound the probe and reap it.
pub(super) fn binary_runs(binary: &Path) -> bool {
    #[cfg(windows)]
    {
        let mut header = [0_u8; 2];
        let valid_pe = std::fs::File::open(binary)
            .and_then(|mut file| file.read_exact(&mut header))
            .is_ok()
            && header == [b'M', b'Z'];
        if !valid_pe {
            return false;
        }
    }
    let mut cmd = std::process::Command::new(binary);
    cmd.arg("--version");
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let Ok(mut child) = cmd.spawn() else {
        return false;
    };
    let deadline = Instant::now() + RUSTUP_SHIM_PROBE_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Ok(None) | Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

pub(super) fn command_availability_cache()
-> &'static StdMutex<HashMap<String, CachedCommandAvailability>> {
    COMMAND_AVAILABILITY_CACHE.get_or_init(|| StdMutex::new(HashMap::new()))
}

pub(super) fn clear_command_availability_cache() {
    command_availability_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clear();
}

pub(super) fn command_line(command: &str, args: &[String]) -> String {
    if args.is_empty() {
        command.to_string()
    } else {
        format!("{} {}", command, args.join(" "))
    }
}

pub(super) fn find_preset(id: &str) -> Option<LspServerPreset> {
    lsp_presets().into_iter().find(|preset| preset.id == id)
}

pub(super) fn cmd(
    id: &str,
    label: &str,
    command: &str,
    args: &[&str],
    install_hint: &str,
    fallback: bool,
) -> LspServerCommandPreset {
    LspServerCommandPreset {
        id: id.into(),
        label: label.into(),
        command: command.into(),
        args: args.iter().map(|arg| (*arg).into()).collect(),
        install_hint: install_hint.into(),
        fallback,
    }
}

/// OS-aware install hints for language servers that lack a single cross-platform package.
pub(super) fn install_hint_for(command_id: &str) -> String {
    let os = std::env::consts::OS;
    match command_id {
        "jdtls" => match os {
            "macos" => {
                "Requires JDK 21+ (current JDT LS). macOS: brew install jdtls. \
Or download Eclipse JDT LS (https://download.eclipse.org/jdtls/snapshots/) and put `jdtls` on PATH (config_mac)."
                    .into()
            }
            "windows" => {
                "Requires JDK 21+ (current JDT LS; JDK 17 exits immediately). Windows: download \
https://download.eclipse.org/jdtls/snapshots/jdt-language-server-latest.tar.gz, extract to \
%LOCALAPPDATA%\\jdtls, ensure java 21+ on PATH / JAVA_HOME."
                    .into()
            }
            _ => {
                "Requires JDK 21+ (current JDT LS). Linux: download Eclipse JDT LS tarball \
(https://download.eclipse.org/jdtls/snapshots/), extract to ~/.local/share/jdtls, wrap launcher with config_linux as `jdtls` on PATH. \
Arch: pacman -S jdtls (if available)."
                    .into()
            }
        },
        "clangd" => match os {
            "macos" => "brew install llvm  # then ensure clangd is on PATH".into(),
            "windows" => {
                "Install LLVM (https://llvm.org/) or use winget/choco `llvm`; ensure `clangd` is on PATH"
                    .into()
            }
            _ => {
                "sudo apt install clangd  # Debian/Ubuntu; or install LLVM clangd package for your distro"
                    .into()
            }
        },
        "kotlin-lsp" => {
            "Install JetBrains' official Kotlin LSP release and put `kotlin-lsp` on PATH: https://github.com/Kotlin/kotlin-lsp/releases"
                .into()
        }
        "kotlin-language-server" => match os {
            "macos" => {
                "brew install kotlin-language-server  # or download from \
https://github.com/fwcd/kotlin-language-server/releases"
                    .into()
            }
            _ => {
                "Download kotlin-language-server from \
https://github.com/fwcd/kotlin-language-server/releases and put it on PATH"
                    .into()
            }
        },
        "metals" => match os {
            "macos" => "brew install metals  # or: coursier install metals".into(),
            _ => {
                "Install Metals: coursier install metals  # or see https://scalameta.org/metals/docs/"
                    .into()
            }
        },
        "omnisharp" => match os {
            "macos" => "brew install omnisharp  # or download OmniSharp from GitHub releases".into(),
            "windows" => {
                "Install OmniSharp-roslyn release and ensure `omnisharp` is on PATH".into()
            }
            _ => "Install OmniSharp-roslyn and ensure `omnisharp` is on PATH".into(),
        },
        "sourcekit-lsp" => match os {
            "macos" => "Install Xcode or Swift toolchain (sourcekit-lsp ships with it)".into(),
            _ => {
                "Install Swift toolchain from https://www.swift.org/ and ensure `sourcekit-lsp` is on PATH"
                    .into()
            }
        },
        _ => format!("Install `{command_id}` and ensure it is on PATH"),
    }
}

pub fn lsp_presets() -> Vec<LspServerPreset> {
    vec![
        LspServerPreset {
            id: "typescript-javascript".into(),
            display_name: "TypeScript / JavaScript".into(),
            document_language_ids: vec![
                "typescript".into(),
                "typescriptreact".into(),
                "javascript".into(),
                "javascriptreact".into(),
            ],
            file_extensions: vec![
                "ts".into(),
                "tsx".into(),
                "mts".into(),
                "cts".into(),
                "js".into(),
                "jsx".into(),
                "mjs".into(),
                "cjs".into(),
            ],
            file_names: vec![],
            commands: vec![cmd(
                "typescript-language-server",
                "typescript-language-server",
                "typescript-language-server",
                &["--stdio"],
                "npm install -g typescript typescript-language-server",
                false,
            )],
        },
        LspServerPreset {
            id: "rust".into(),
            display_name: "Rust".into(),
            document_language_ids: vec!["rust".into()],
            file_extensions: vec!["rs".into()],
            file_names: vec![],
            commands: vec![cmd(
                "rust-analyzer",
                "rust-analyzer",
                "rust-analyzer",
                &[],
                "rustup component add rust-analyzer",
                false,
            )],
        },
        LspServerPreset {
            id: "python".into(),
            display_name: "Python".into(),
            document_language_ids: vec!["python".into()],
            file_extensions: vec!["py".into(), "pyi".into()],
            file_names: vec![],
            commands: vec![cmd(
                "pyright",
                "pyright-langserver",
                "pyright-langserver",
                &["--stdio"],
                "npm install -g pyright",
                false,
            )],
        },
        LspServerPreset {
            id: "go".into(),
            display_name: "Go".into(),
            document_language_ids: vec!["go".into()],
            file_extensions: vec!["go".into()],
            file_names: vec![],
            commands: vec![cmd(
                "gopls",
                "gopls",
                "gopls",
                &[],
                "go install golang.org/x/tools/gopls@latest",
                false,
            )],
        },
        LspServerPreset {
            id: "java".into(),
            display_name: "Java".into(),
            document_language_ids: vec!["java".into()],
            file_extensions: vec!["java".into()],
            file_names: vec![],
            commands: vec![cmd(
                "jdtls",
                "jdtls",
                "jdtls",
                &[],
                &install_hint_for("jdtls"),
                false,
            )],
        },
        LspServerPreset {
            id: "cpp".into(),
            display_name: "C / C++".into(),
            document_language_ids: vec!["c".into(), "cpp".into()],
            file_extensions: vec![
                "c".into(),
                "h".into(),
                "cc".into(),
                "cpp".into(),
                "cxx".into(),
                "hpp".into(),
                "hh".into(),
                "hxx".into(),
            ],
            file_names: vec![],
            commands: vec![cmd(
                "clangd",
                "clangd",
                "clangd",
                &[],
                &install_hint_for("clangd"),
                false,
            )],
        },
        LspServerPreset {
            id: "kotlin".into(),
            display_name: "Kotlin".into(),
            document_language_ids: vec!["kotlin".into()],
            file_extensions: vec!["kt".into(), "kts".into()],
            file_names: vec![],
            commands: vec![
                cmd(
                    "kotlin-lsp",
                    "Kotlin LSP (official)",
                    "kotlin-lsp",
                    &[],
                    &install_hint_for("kotlin-lsp"),
                    false,
                ),
                cmd(
                    "kotlin-language-server",
                    "kotlin-language-server (community)",
                    "kotlin-language-server",
                    &[],
                    &install_hint_for("kotlin-language-server"),
                    true,
                ),
            ],
        },
        LspServerPreset {
            id: "scala".into(),
            display_name: "Scala".into(),
            document_language_ids: vec!["scala".into()],
            file_extensions: vec!["scala".into(), "sc".into()],
            file_names: vec![],
            commands: vec![cmd(
                "metals",
                "Metals",
                "metals",
                &[],
                &install_hint_for("metals"),
                false,
            )],
        },
        LspServerPreset {
            id: "csharp".into(),
            display_name: "C#".into(),
            document_language_ids: vec!["csharp".into()],
            file_extensions: vec!["cs".into(), "csx".into()],
            file_names: vec![],
            commands: vec![
                cmd(
                    "csharp-ls",
                    "csharp-ls",
                    "csharp-ls",
                    &["--features", "metadata-uris"],
                    "dotnet tool install -g csharp-ls",
                    false,
                ),
                cmd(
                    "omnisharp",
                    "OmniSharp",
                    "omnisharp",
                    &["--languageserver"],
                    &install_hint_for("omnisharp"),
                    true,
                ),
            ],
        },
        LspServerPreset {
            id: "swift".into(),
            display_name: "Swift".into(),
            document_language_ids: vec!["swift".into()],
            file_extensions: vec!["swift".into()],
            file_names: vec![],
            commands: vec![cmd(
                "sourcekit-lsp",
                "SourceKit-LSP",
                "sourcekit-lsp",
                &[],
                &install_hint_for("sourcekit-lsp"),
                false,
            )],
        },
    ]
}
