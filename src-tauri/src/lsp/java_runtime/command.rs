use super::data::ensure_jdtls_data_dir;
use super::data::jdtls_data_dir;
use super::selection::java_home_from_binary;
use super::selection::resolve_java_for_jdtls_with_sdk;
use super::vmargs::jdtls_vmargs;
use crate::lsp::limits::JDTLS_MIN_JAVA_MAJOR;
use crate::lsp::presets::cmd;
use std::path::Path;
use std::path::PathBuf;
use tokio::process::Command;

pub(in crate::lsp) fn is_jdtls_program(program: &str, resolved: &Path) -> bool {
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
pub(in crate::lsp) fn windows_cmd_line(program: &Path, args: &[String]) -> String {
    let mut line = format!("\"{}\"", program.display());
    for arg in args {
        line.push(' ');
        line.push_str(&windows_quote_arg(arg));
    }
    line
}

#[cfg(windows)]
pub(in crate::lsp) fn windows_quote_arg(arg: &str) -> String {
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
pub(in crate::lsp) fn resolve_server_program(program: &str) -> PathBuf {
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
pub(in crate::lsp) fn build_jdtls_java_command(
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
pub(in crate::lsp) fn resolve_jdtls_home(jdtls_path: &Path) -> Option<PathBuf> {
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
pub(in crate::lsp) fn find_equinox_launcher(jdtls_home: &Path) -> Option<PathBuf> {
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
