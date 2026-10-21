use super::*;

pub(super) fn is_jdtls_program(program: &str, resolved: &Path) -> bool {
    let name = program.to_ascii_lowercase();
    if name.contains("jdtls") {
        return true;
    }
    resolved
        .file_stem()
        .and_then(|stem| stem.to_str())
        .is_some_and(|stem| stem.eq_ignore_ascii_case("jdtls"))
}

/// Quote a Windows cmdline for `cmd.exe /S /C` so the batch path and args are
/// preserved: `"C:\path\tool.cmd" --stdio`.
#[cfg(windows)]
pub(super) fn windows_cmd_line(program: &Path, args: &[String]) -> String {
    let mut line = format!("\"{}\"", program.display());
    for arg in args {
        line.push(' ');
        line.push_str(&windows_quote_arg(arg));
    }
    line
}

#[cfg(windows)]
pub(super) fn windows_quote_arg(arg: &str) -> String {
    if arg.is_empty() {
        return "\"\"".into();
    }
    if !arg.chars().any(|c| c.is_whitespace() || c == '"') {
        return arg.to_string();
    }
    let mut out = String::from("\"");
    for ch in arg.chars() {
        if ch == '"' {
            out.push_str("\"\"");
        } else {
            out.push(ch);
        }
    }
    out.push('"');
    out
}

#[cfg(windows)]
pub(super) fn resolve_server_program(program: &str) -> PathBuf {
    let path = Path::new(program);
    if path.is_absolute() || program.contains('/') || program.contains('\\') {
        return path.to_path_buf();
    }
    which::which(program).unwrap_or_else(|_| PathBuf::from(program))
}

/// Expand `jdtls` / `jdtls.cmd` into a direct `java -jar …` command matching the
/// upstream `jdtls.py` launcher so stdio attaches to the JVM.
///
/// Critical details vs our old minimal command line:
/// - Current JDT LS needs **Java 21+** (JDK 17 exits immediately → "stdout closed").
/// - Use OSGi *shared* read-only `config_win` + writable `-data` (not
///   `-configuration config_win`, which often fails under a GUI process).
/// - Pass `--add-modules` / `--add-opens` required by modern Equinox on JPMS.
#[cfg(windows)]
pub(super) fn build_jdtls_java_command(
    jdtls_path: &Path,
    extra_args: &[String],
    workspace_root: &Path,
    tooling_java_home: Option<&Path>,
    tooling_java_error: Option<&str>,
) -> Result<Command, String> {
    let jdtls_home = resolve_jdtls_home(jdtls_path).ok_or_else(|| {
        format!(
            "cannot locate jdtls install (plugins/) from {}; set JDTLS_HOME or install under %LOCALAPPDATA%\\jdtls",
            jdtls_path.display()
        )
    })?;
    let launcher = find_equinox_launcher(&jdtls_home).ok_or_else(|| {
        format!(
            "equinox launcher jar missing under {}\\plugins",
            jdtls_home.display()
        )
    })?;
    let shared_config = jdtls_home.join("config_win");
    if !shared_config.is_dir() {
        return Err(format!(
            "jdtls config_win missing under {} (is the Windows archive fully extracted?)",
            jdtls_home.display()
        ));
    }
    let (java, java_major) =
        resolve_java_for_jdtls_with_sdk(tooling_java_home, tooling_java_error)?;
    if java_major < JDTLS_MIN_JAVA_MAJOR {
        return Err(format!(
            "jdtls requires Java {JDTLS_MIN_JAVA_MAJOR}+ (current Eclipse JDT LS); found Java {java_major} at {}. Install JDK {JDTLS_MIN_JAVA_MAJOR}+, configure it in Settings → Language Servers, or set JAVA_HOME",
            java.display()
        ));
    }
    let data_dir = jdtls_data_dir(workspace_root);
    ensure_jdtls_data_dir(&data_dir, workspace_root)?;

    // Mirror eclipse.jdt.ls product scripts/jdtls.py (shared config + JPMS opens).
    let mut cmd = Command::new(&java);
    if java_major >= 24 {
        cmd.arg("-Djdk.xml.maxGeneralEntitySizeLimit=0");
        cmd.arg("-Djdk.xml.totalEntitySizeLimit=0");
    }
    cmd.arg("-Declipse.application=org.eclipse.jdt.ls.core.id1");
    cmd.arg("-Dosgi.bundles.defaultStartLevel=4");
    cmd.arg("-Declipse.product=org.eclipse.jdt.ls.core.product");
    cmd.arg("-Dosgi.checkConfiguration=true");
    cmd.arg(format!(
        "-Dosgi.sharedConfiguration.area={}",
        shared_config.display()
    ));
    cmd.arg("-Dosgi.sharedConfiguration.area.readOnly=true");
    cmd.arg("-Dosgi.configuration.cascaded=true");
    cmd.arg("-Dlog.level=ERROR");
    // User/default vmargs (heap, GC, extra -D…, etc.) between product props and JPMS.
    for arg in jdtls_vmargs() {
        cmd.arg(arg);
    }
    cmd.arg("--add-modules=ALL-SYSTEM");
    cmd.arg("--add-opens");
    cmd.arg("java.base/java.util=ALL-UNNAMED");
    cmd.arg("--add-opens");
    cmd.arg("java.base/java.lang=ALL-UNNAMED");
    cmd.arg("-jar");
    cmd.arg(launcher);
    cmd.arg("-data");
    cmd.arg(&data_dir);
    cmd.args(extra_args);
    if let Some(home) = java_home_from_binary(&java) {
        cmd.env("JAVA_HOME", home);
    }
    log::info!(
        "lsp: launching jdtls via {} (Java {java_major}), home={}, data={}",
        java.display(),
        jdtls_home.display(),
        data_dir.display()
    );
    Ok(cmd)
}

#[cfg(windows)]
pub(super) fn resolve_jdtls_home(jdtls_path: &Path) -> Option<PathBuf> {
    if let Ok(home) = std::env::var("JDTLS_HOME") {
        let home = PathBuf::from(home);
        if home.join("plugins").is_dir() {
            return Some(home);
        }
    }
    // Install guide layout: %LOCALAPPDATA%\jdtls-bin\jdtls.cmd + %LOCALAPPDATA%\jdtls
    if let Some(bin_dir) = jdtls_path.parent() {
        if let Some(local) = bin_dir.parent() {
            let candidate = local.join("jdtls");
            if candidate.join("plugins").is_dir() {
                return Some(candidate);
            }
        }
        // jdtls.cmd living next to an extracted distribution
        if bin_dir.join("plugins").is_dir() {
            return Some(bin_dir.to_path_buf());
        }
        if let Some(parent) = bin_dir.parent() {
            if parent.join("plugins").is_dir() {
                return Some(parent.to_path_buf());
            }
        }
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let candidate = PathBuf::from(local).join("jdtls");
        if candidate.join("plugins").is_dir() {
            return Some(candidate);
        }
    }
    None
}

#[cfg(windows)]
pub(super) fn find_equinox_launcher(jdtls_home: &Path) -> Option<PathBuf> {
    let plugins = jdtls_home.join("plugins");
    // mason-registry packaging uses an unversioned jar name.
    let plain = plugins.join("org.eclipse.equinox.launcher.jar");
    if plain.is_file() {
        return Some(plain);
    }
    let mut matches: Vec<PathBuf> = std::fs::read_dir(&plugins)
        .ok()?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    name.starts_with("org.eclipse.equinox.launcher_") && name.ends_with(".jar")
                })
        })
        .collect();
    matches.sort();
    matches.pop()
}

pub(super) fn configured_java_vmargs_lock() -> &'static StdMutex<Option<String>> {
    CONFIGURED_JAVA_VMARGS.get_or_init(|| StdMutex::new(None))
}

pub(super) fn set_configured_java_vmargs(vmargs: Option<&str>) {
    let normalized = vmargs
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if let Ok(mut guard) = configured_java_vmargs_lock().lock() {
        *guard = normalized;
    }
}

pub(super) fn get_configured_java_vmargs() -> Option<String> {
    configured_java_vmargs_lock()
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
}

/// Effective jdtls JVM args string (Settings override or default 1G heap).
pub(super) fn jdtls_vmargs_string() -> String {
    get_configured_java_vmargs().unwrap_or_else(|| DEFAULT_JDTLS_VMARGS.to_string())
}

/// Split JVM arg strings with simple shell-style quoting (spaces, "…", '…').
pub(super) fn split_jvm_args(raw: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for ch in raw.chars() {
        if escaped {
            current.push(ch);
            escaped = false;
            continue;
        }
        if ch == '\\' && quote != Some('\'') {
            escaped = true;
            continue;
        }
        if let Some(q) = quote {
            if ch == q {
                quote = None;
            } else {
                current.push(ch);
            }
            continue;
        }
        match ch {
            '"' | '\'' => quote = Some(ch),
            c if c.is_whitespace() => {
                if !current.is_empty() {
                    args.push(std::mem::take(&mut current));
                }
            }
            _ => current.push(ch),
        }
    }
    if !current.is_empty() {
        args.push(current);
    }
    args
}

pub(super) fn jdtls_vmargs() -> Vec<String> {
    let mut args = split_jvm_args(&jdtls_vmargs_string());
    if let Some(agent) = lombok_javaagent_arg() {
        args.push(agent);
    }
    args
}

/// Apply Settings JVM args as JAVA_OPTS for the jdtls wrapper (Linux/macOS).
/// Settings win over a parent-shell JAVA_OPTS so heap/GC overrides are not ignored.
/// Includes the Lombok `-javaagent` when configured so wrapper launches match the
/// direct-launch path.
pub(super) fn apply_jdtls_vmargs_to_command(cmd: &mut Command) {
    cmd.env("JAVA_OPTS", jdtls_vmargs().join(" "));
}

/// Lombok `-javaagent:<jar>` when Lombok is enabled with a configured jar path.
/// Short-term M6-A path (full bundle loading arrives with the jdtls bundle work).
pub(super) fn lombok_javaagent_arg() -> Option<String> {
    let settings = get_configured_java_settings();
    let jar = settings.lombok_jar_path.as_deref().map(str::trim)?;
    if !settings.lombok_enabled || jar.is_empty() {
        return None;
    }
    Some(format!("-javaagent:{jar}"))
}

/// User-configured `java.*` settings mirrored from Language Servers settings. Serde
/// fills any omitted field from [`Self::default`] so partial payloads stay valid.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct JavaLanguageSettings {
    /// Background compile the whole project (prerequisite for full-project diagnostics).
    pub autobuild_enabled: bool,
    /// Lombok `-javaagent` support toggle.
    pub lombok_enabled: bool,
    /// Absolute path to a `lombok.jar` used for the `-javaagent`.
    pub lombok_jar_path: Option<String>,
    /// Run `source.organizeImports` on save.
    pub save_actions_organize_imports: bool,
    /// Eclipse/Google formatter profile URL or file path (empty → jdtls default).
    pub format_settings_url: Option<String>,
    /// Named profile inside the formatter settings file.
    pub format_settings_profile: Option<String>,
    /// Guess method arguments when completing calls.
    pub guess_method_arguments: bool,
    /// Import groups in organize-imports order (e.g. `["java","javax","com","org"]`).
    /// Empty → jdtls default order.
    pub completion_import_order: Vec<String>,
    /// Static members offered eagerly in completion (e.g. JUnit/Mockito).
    pub favorite_static_members: Vec<String>,
    /// `import` count before collapsing to `import a.*`.
    pub organize_imports_star_threshold: u32,
    /// static `import` count before collapsing to `import static a.*`.
    pub organize_imports_static_star_threshold: u32,
    /// Enable Maven importer.
    pub maven_import_enabled: bool,
    /// Enable Gradle importer.
    pub gradle_import_enabled: bool,
}

impl Default for JavaLanguageSettings {
    fn default() -> Self {
        Self {
            autobuild_enabled: true,
            lombok_enabled: false,
            lombok_jar_path: None,
            save_actions_organize_imports: false,
            format_settings_url: None,
            format_settings_profile: None,
            guess_method_arguments: true,
            completion_import_order: Vec::new(),
            favorite_static_members: vec![
                "org.junit.Assert.*".into(),
                "org.junit.Assume.*".into(),
                "org.junit.jupiter.api.Assertions.*".into(),
                "org.junit.jupiter.api.Assumptions.*".into(),
                "org.mockito.Mockito.*".into(),
                "org.mockito.ArgumentMatchers.*".into(),
            ],
            organize_imports_star_threshold: 99,
            organize_imports_static_star_threshold: 99,
            maven_import_enabled: true,
            gradle_import_enabled: true,
        }
    }
}

/// Trim a string option to a JSON string value, or `Null` when empty/absent.
pub(super) fn non_empty_or_null(value: Option<&str>) -> Value {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => Value::String(value.to_string()),
        None => Value::Null,
    }
}
impl JavaLanguageSettings {
    /// Build the `java` object for `settings.java` (initialize + didChangeConfiguration).
    /// `runtimes` is threaded in separately because it is backend-owned per project.
    pub(super) fn to_java_settings(&self, runtimes: &[JavaRuntimeConfiguration]) -> Value {
        // Only carry runtimes when we actually have them: a live
        // didChangeConfiguration push sends `&[]` and must NOT clobber the JDK
        // config jdtls already resolved at initialize with an empty array.
        let mut configuration = json!({ "updateBuildConfiguration": "interactive" });
        if !runtimes.is_empty() {
            configuration["runtimes"] = json!(runtimes);
        }
        json!({
            "autobuild": { "enabled": self.autobuild_enabled },
            "maxConcurrentBuilds": 1,
            "configuration": configuration,
            "completion": {
                "enabled": true,
                "guessMethodArguments": self.guess_method_arguments,
                "importOrder": self.completion_import_order,
                "favoriteStaticMembers": self.favorite_static_members
            },
            "format": {
                "enabled": true,
                "settings": {
                    "url": non_empty_or_null(self.format_settings_url.as_deref()),
                    "profile": non_empty_or_null(self.format_settings_profile.as_deref())
                },
                "onType": { "enabled": true }
            },
            "import": {
                "maven": { "enabled": self.maven_import_enabled },
                "gradle": {
                    "enabled": self.gradle_import_enabled,
                    "wrapper": { "enabled": true },
                    "offline": { "enabled": false }
                }
            },
            "sources": {
                "organizeImports": {
                    "starThreshold": self.organize_imports_star_threshold,
                    "staticStarThreshold": self.organize_imports_static_star_threshold
                }
            },
            "saveActions": { "organizeImports": self.save_actions_organize_imports },
            "codeGeneration": {
                "hashCodeEquals": { "useJava7Objects": true },
                "useBlocks": true,
                "generateComments": false,
                "toString": {
                    "template": "${object.className} [${member.name()}=${member.value}, ${otherMembers}]"
                }
            },
            "referencesCodeLens": { "enabled": false },
            "implementationsCodeLens": { "enabled": false },
            "signatureHelp": { "enabled": true },
            "inlayHints": { "parameterNames": { "enabled": "all" } },
            "errors": { "incompleteClasspath": { "severity": "warning" } }
        })
    }
}
pub(super) fn configured_java_settings_lock() -> &'static StdMutex<Option<JavaLanguageSettings>> {
    CONFIGURED_JAVA_SETTINGS.get_or_init(|| StdMutex::new(None))
}

pub(super) fn set_configured_java_settings(settings: Option<JavaLanguageSettings>) {
    if let Ok(mut guard) = configured_java_settings_lock().lock() {
        *guard = settings;
    }
}

/// Effective `java.*` settings (Settings override or defaults).
pub(super) fn get_configured_java_settings() -> JavaLanguageSettings {
    configured_java_settings_lock()
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
        .unwrap_or_default()
}

pub(super) fn configured_java_home_lock() -> &'static StdMutex<Option<PathBuf>> {
    CONFIGURED_JAVA_HOME.get_or_init(|| StdMutex::new(None))
}

/// Store the Settings-configured JDK path (or clear with `None`).
pub(super) fn set_configured_java_home(java_home: Option<&str>) {
    let path = java_home
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);
    if let Ok(mut guard) = configured_java_home_lock().lock() {
        *guard = path;
    }
}

pub(super) fn get_configured_java_home() -> Option<PathBuf> {
    configured_java_home_lock()
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
}

/// Expand a user/env path that may be a JDK home, `bin/`, or the `java` binary.
pub(super) fn resolve_java_binary_from_user_path(path: &Path) -> Option<PathBuf> {
    let bin_name = if cfg!(windows) { "java.exe" } else { "java" };
    if path.is_file() {
        return Some(path.to_path_buf());
    }
    if !path.is_dir() {
        return None;
    }
    let direct = path.join(bin_name);
    if direct.is_file() {
        return Some(direct);
    }
    let in_bin = path.join("bin").join(bin_name);
    if in_bin.is_file() {
        return Some(in_bin);
    }
    // macOS `.jdk` bundles: Contents/Home/bin/java
    let mac = path
        .join("Contents")
        .join("Home")
        .join("bin")
        .join(bin_name);
    if mac.is_file() {
        return Some(mac);
    }
    None
}

pub(super) fn java_home_from_binary(java: &Path) -> Option<PathBuf> {
    let parent = java.parent()?;
    if parent
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.eq_ignore_ascii_case("bin"))
    {
        return parent.parent().map(|p| p.to_path_buf());
    }
    Some(parent.to_path_buf())
}

pub(super) fn push_java_candidate(candidates: &mut Vec<PathBuf>, path: PathBuf) {
    if !candidates.iter().any(|c| c == &path) {
        candidates.push(path);
    }
}

/// Pick a Java executable for jdtls, preferring the highest major >= 21.
/// Order: configured Settings path → JAVA_HOME → PATH → common install layouts.
pub(super) fn resolve_java_for_jdtls() -> Result<(PathBuf, u32), String> {
    resolve_java_for_jdtls_with_sdk(None, None)
}

/// Resolve the JVM that runs JDT LS. The legacy Language Servers override is
/// retained as the highest-precedence migration path; otherwise an explicit
/// workspace tooling-JDK binding wins over process JAVA_HOME/PATH discovery.
pub(super) fn resolve_java_for_jdtls_with_sdk(
    tooling_java_home: Option<&Path>,
    tooling_java_error: Option<&str>,
) -> Result<(PathBuf, u32), String> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    let configured_java_home = get_configured_java_home();
    if let Some(configured) = configured_java_home.as_ref() {
        if let Some(bin) = resolve_java_binary_from_user_path(&configured) {
            push_java_candidate(&mut candidates, bin);
        } else {
            return Err(format!(
                "configured Java runtime path is invalid: {} (expected JDK home or java binary, JDK {JDTLS_MIN_JAVA_MAJOR}+)",
                configured.display()
            ));
        }
    } else {
        if let Some(error) = tooling_java_error {
            return Err(error.to_string());
        }
        if let Some(tooling) = tooling_java_home {
            if let Some(bin) = resolve_java_binary_from_user_path(tooling) {
                push_java_candidate(&mut candidates, bin);
            } else {
                return Err(format!(
                    "workspace tooling JDK path is invalid: {} (expected JDK home or java binary, JDK {JDTLS_MIN_JAVA_MAJOR}+)",
                    tooling.display()
                ));
            }
        }
    }

    if let Ok(home) = std::env::var("JAVA_HOME") {
        if let Some(bin) = resolve_java_binary_from_user_path(Path::new(&home)) {
            push_java_candidate(&mut candidates, bin);
        }
    }
    if let Ok(path) = which::which("java") {
        push_java_candidate(&mut candidates, path);
    }
    // GUI-launched apps sometimes inherit a PATH that lacks the JDK even when
    // an interactive shell sees it. Probe common install layouts.
    #[cfg(windows)]
    {
        for base in [
            std::env::var_os("ProgramFiles"),
            std::env::var_os("ProgramFiles(x86)"),
        ]
        .into_iter()
        .flatten()
        {
            for vendor in [
                "Java",
                "Eclipse Adoptium",
                "Microsoft",
                "Amazon Corretto",
                "Semeru",
            ] {
                let root = PathBuf::from(&base).join(vendor);
                if let Ok(entries) = std::fs::read_dir(&root) {
                    for entry in entries.flatten() {
                        let candidate = entry.path().join("bin").join("java.exe");
                        if candidate.is_file() {
                            push_java_candidate(&mut candidates, candidate);
                        }
                    }
                }
            }
        }
    }
    #[cfg(not(windows))]
    {
        for dir in [
            "/usr/lib/jvm",
            "/Library/Java/JavaVirtualMachines",
            "/opt/homebrew/opt/openjdk/bin",
            "/usr/local/opt/openjdk/bin",
        ] {
            let root = Path::new(dir);
            if root.is_file() {
                push_java_candidate(&mut candidates, root.to_path_buf());
                continue;
            }
            if root.is_dir() && root.ends_with("bin") {
                let candidate = root.join("java");
                if candidate.is_file() {
                    push_java_candidate(&mut candidates, candidate);
                }
                continue;
            }
            if let Ok(entries) = std::fs::read_dir(root) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    for rel in ["bin/java", "Contents/Home/bin/java"] {
                        let candidate = path.join(rel);
                        if candidate.is_file() {
                            push_java_candidate(&mut candidates, candidate);
                        }
                    }
                }
            }
        }
    }

    if candidates.is_empty() {
        return Err(format!(
            "java not found for jdtls; install JDK {JDTLS_MIN_JAVA_MAJOR}+ and set it in Settings → Language Servers, JAVA_HOME, or PATH"
        ));
    }

    // If the user configured a path, only evaluate that first candidate so a
    // wrong/old override cannot silently fall back to another JDK on PATH.
    let configured_only = configured_java_home.is_some() || tooling_java_home.is_some();
    let search: Vec<PathBuf> = if configured_only {
        candidates.into_iter().take(1).collect()
    } else {
        candidates
    };

    let mut best_ok: Option<(PathBuf, u32)> = None;
    let mut best_any: Option<(PathBuf, u32)> = None;
    let mut last_err = String::new();
    for path in search {
        match java_major_version(&path) {
            Ok(major) => {
                if major >= JDTLS_MIN_JAVA_MAJOR {
                    if best_ok.as_ref().map(|(_, m)| major > *m).unwrap_or(true) {
                        best_ok = Some((path.clone(), major));
                    }
                }
                if best_any.as_ref().map(|(_, m)| major > *m).unwrap_or(true) {
                    best_any = Some((path, major));
                }
            }
            Err(e) => last_err = e,
        }
    }

    if let Some(ok) = best_ok {
        return Ok(ok);
    }
    if let Some((path, major)) = best_any {
        return Err(format!(
            "jdtls requires Java {JDTLS_MIN_JAVA_MAJOR}+ (current Eclipse JDT LS); found Java {major} at {}. Install JDK {JDTLS_MIN_JAVA_MAJOR}+ and configure it in Settings → Language Servers (or JAVA_HOME)",
            path.display()
        ));
    }
    Err(if last_err.is_empty() {
        format!("could not determine Java version for jdtls; need JDK {JDTLS_MIN_JAVA_MAJOR}+")
    } else {
        last_err
    })
}

/// Probe the JVM used by jdtls for Settings / pre-start checks.
/// Returns `(runtime_status label, error if unusable)`.
pub(super) fn jdtls_runtime_probe() -> (Option<String>, Option<String>) {
    match resolve_java_for_jdtls() {
        Ok((path, major)) => {
            let short = path.display().to_string();
            let configured = get_configured_java_home().is_some();
            (
                Some(format!(
                    "Java {major} · {short}{} (JDK {JDTLS_MIN_JAVA_MAJOR}+ required)",
                    if configured { " · configured" } else { "" }
                )),
                None,
            )
        }
        Err(error) => {
            // Prefer a compact status line for the Settings row.
            let status = if let Some(major) = error
                .split("found Java ")
                .nth(1)
                .and_then(|rest| rest.split_whitespace().next())
                .and_then(|s| s.parse::<u32>().ok())
            {
                Some(format!(
                    "Java {major} — need JDK {JDTLS_MIN_JAVA_MAJOR}+ for current JDT LS"
                ))
            } else if error.contains("java not found") || error.contains("invalid") {
                Some(format!(
                    "Java not found — need JDK {JDTLS_MIN_JAVA_MAJOR}+ for jdtls"
                ))
            } else {
                Some(format!(
                    "Java runtime issue (need JDK {JDTLS_MIN_JAVA_MAJOR}+)"
                ))
            };
            (status, Some(error))
        }
    }
}

pub(super) fn command_is_jdtls(command: &LspServerCommandPreset) -> bool {
    command.id.eq_ignore_ascii_case("jdtls")
        || command.command.to_ascii_lowercase().contains("jdtls")
}

pub(super) fn preset_uses_jdtls(
    preset: &LspServerPreset,
    command: Option<&LspServerCommandPreset>,
) -> bool {
    if preset.id == "java" {
        return true;
    }
    command.is_some_and(command_is_jdtls) || preset.commands.iter().any(command_is_jdtls)
}

/// Parse `java -version` output (`openjdk version "17.0.4"` / `"21.0.2"` / `"1.8.0_xxx"`).
pub(super) fn java_major_version(java: &Path) -> Result<u32, String> {
    let mut cmd = std::process::Command::new(java);
    cmd.arg("-version");
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd
        .output()
        .map_err(|e| format!("failed to run {} -version: {e}", java.display()))?;
    let text = {
        let err = String::from_utf8_lossy(&output.stderr);
        let out = String::from_utf8_lossy(&output.stdout);
        if !err.trim().is_empty() {
            err.into_owned()
        } else {
            out.into_owned()
        }
    };
    parse_java_major_from_version_output(&text).ok_or_else(|| {
        format!(
            "could not parse Java version from {} -version output: {}",
            java.display(),
            text.lines().next().unwrap_or("(empty)").trim()
        )
    })
}

pub(super) fn parse_java_major_from_version_output(text: &str) -> Option<u32> {
    // version "21.0.2" | version "17.0.4" | version "1.8.0_392"
    for line in text.lines() {
        let Some(after) = line.split("version").nth(1) else {
            continue;
        };
        let Some(start) = after.find('"') else {
            continue;
        };
        let rest = &after[start + 1..];
        let end = rest.find('"').unwrap_or(rest.len());
        let ver = rest[..end].trim();
        let mut parts = ver.split(['.', '_', '-']);
        let first: u32 = parts.next()?.parse().ok()?;
        if first == 1 {
            return parts.next()?.parse().ok();
        }
        return Some(first);
    }
    None
}

/// Root that holds every per-workspace jdtls `-data` directory.
///
/// Windows keeps the historical `%LOCALAPPDATA%\jdtls-ws`; other platforms use the
/// user cache dir (`~/.cache/jdtls-ws` on Linux, `~/Library/Caches/jdtls-ws` on
/// macOS) so the location is ours to manage rather than left to the wrapper script.
pub(super) fn jdtls_data_root() -> PathBuf {
    #[cfg(windows)]
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        return PathBuf::from(local).join("jdtls-ws");
    }
    #[cfg(not(windows))]
    if let Some(cache) = dirs::cache_dir() {
        return cache.join("jdtls-ws");
    }
    std::env::temp_dir().join("jdtls-ws")
}

/// Per-workspace jdtls index/metadata directory. Keyed by the project scope path so
/// the same project reuses its index across restarts, while distinct projects stay
/// isolated (matching how IDEA keeps one index per project).
pub(super) fn jdtls_data_dir(workspace_root: &Path) -> PathBuf {
    let mut hasher = DefaultHasher::new();
    workspace_root.to_string_lossy().hash(&mut hasher);
    let digest = format!("{:x}", hasher.finish());
    jdtls_data_root().join(digest)
}

/// Best-effort prune of stale jdtls index directories.
///
/// Each `-data` dir carries a `.taomni-workspace` marker naming the project it
/// indexes; when that project path no longer exists on disk, the whole index is
/// removed so abandoned/renamed projects do not accumulate unbounded disk usage.
/// Runs on a blocking thread and never fails the caller.
pub(super) fn prune_stale_jdtls_data_dirs() {
    let root = jdtls_data_root();
    let entries = match std::fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let marker = dir.join(JDTLS_WORKSPACE_MARKER);
        let Ok(project) = std::fs::read_to_string(&marker) else {
            // No marker (older layout or partial dir): leave it alone to be safe.
            continue;
        };
        let project = project.trim();
        if project.is_empty() || Path::new(project).exists() {
            continue;
        }
        if let Err(error) = std::fs::remove_dir_all(&dir) {
            log::warn!(
                "lsp: failed to prune stale jdtls data dir {} (project {project} gone): {error}",
                dir.display()
            );
        } else {
            log::info!(
                "lsp: pruned stale jdtls data dir {} (project {project} no longer exists)",
                dir.display()
            );
        }
    }
}

/// Create `data_dir` and stamp the `.taomni-workspace` marker with `workspace_root`
/// so [`prune_stale_jdtls_data_dirs`] can later tell which project it belongs to.
pub(super) fn ensure_jdtls_data_dir(data_dir: &Path, workspace_root: &Path) -> Result<(), String> {
    std::fs::create_dir_all(data_dir)
        .map_err(|e| format!("cannot create jdtls data dir {}: {e}", data_dir.display()))?;
    // Marker write is best-effort: a missing marker only disables pruning for this dir.
    let _ = std::fs::write(
        data_dir.join(JDTLS_WORKSPACE_MARKER),
        workspace_root.to_string_lossy().as_bytes(),
    );
    Ok(())
}
