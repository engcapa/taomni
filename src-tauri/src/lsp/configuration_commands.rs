use super::*;

#[tauri::command]
pub fn lsp_list_presets() -> Vec<LspServerPreset> {
    lsp_presets()
}

/// Persist the Settings-configured Java runtime for jdtls (JDK home or java binary).
/// Empty / null clears the override and falls back to JAVA_HOME / PATH discovery.
#[tauri::command]
pub fn lsp_set_java_home(java_home: Option<String>) -> Result<(), String> {
    set_configured_java_home(java_home.as_deref());
    Ok(())
}

/// Persist Settings-configured jdtls JVM args (e.g. `-Xmx2G -XX:+UseG1GC`).
/// Null/empty restores the default (`-Xms1024m -Xmx1024m`). Takes effect on the
/// next jdtls process start (workspace restart).
#[tauri::command]
pub fn lsp_set_java_vmargs(vmargs: Option<String>) -> Result<String, String> {
    set_configured_java_vmargs(vmargs.as_deref());
    Ok(jdtls_vmargs_string())
}

/// Persist the Settings-configured `java.*` language settings (Lombok, autobuild,
/// organize imports, code generation, …) and hot-apply them to every ready jdtls
/// session via `workspace/didChangeConfiguration`. `None` restores defaults.
///
/// Fields that only take effect at process start (Lombok `-javaagent`) apply on the
/// next workspace restart; the rest update live. Returns the number of sessions
/// that received the live update.
#[tauri::command]
pub async fn lsp_set_java_settings(
    state: State<'_, AppState>,
    settings: Option<JavaLanguageSettings>,
) -> Result<usize, String> {
    set_configured_java_settings(settings);
    // Reuse the resolved settings (defaults when cleared). Runtimes are irrelevant
    // to a live config push — jdtls keeps the ones from initialize.
    let java_settings = get_configured_java_settings().to_java_settings(&[]);
    let notified = state
        .workspace
        .lsp
        .notify_all_jdtls(
            "workspace/didChangeConfiguration",
            json!({ "settings": { "java": java_settings } }),
        )
        .await;
    Ok(notified)
}

/// Persist the Settings-configured jdtls extension bundle paths (java-debug /
/// java-test). Applied on the next jdtls start via `initializationOptions.bundles`
/// (bundles cannot be hot-added). `None` fields clear that bundle.
#[tauri::command]
pub fn lsp_set_java_bundles(config: crate::java_bundles::JavaBundleConfig) -> Result<(), String> {
    crate::java_bundles::set_configured_bundles(config);
    Ok(())
}

/// Probe the configured jdtls extension bundles (java-debug / java-test) for the
/// Settings UI: which are found and the resolved jar path.
#[tauri::command]
pub fn lsp_detect_java_bundles() -> Vec<crate::java_bundles::BundleStatus> {
    crate::java_bundles::probe_bundles(&crate::java_bundles::get_configured_bundles())
}

/// Scan installed VS Code / Cursor / VSCodium extensions for the java-debug and
/// java-test plugin jars so the user can adopt them in one click instead of
/// hunting for a path or downloading anything (the common "setup is complex"
/// case — the jar already ships with a Java extension they have installed).
#[tauri::command]
pub fn lsp_discover_java_bundles() -> Vec<crate::java_bundles::DiscoveredBundle> {
    crate::java_bundles::discover_bundles()
}

#[tauri::command]
pub fn lsp_detect_servers(java_home: Option<String>) -> Vec<LspServerStatus> {
    // Accept an optional override so Settings can probe without waiting for a
    // separate set-home round-trip; also keep the process-global config in sync.
    if let Some(ref home) = java_home {
        set_configured_java_home(Some(home.as_str()));
    }
    clear_command_availability_cache();
    lsp_presets()
        .iter()
        .map(|preset| server_status(preset, None, false, None))
        .collect()
}
