//! jdtls extension bundle resolution (M8 Bundle 基建).
//!
//! jdtls loads extensions via `initializationOptions.bundles[]` — an array of
//! absolute jar paths. Debugging (java-debug) and testing (java-test) are such
//! extensions. This module resolves the highest-versioned jar for each from a
//! user-configured directory (or an explicit jar path) and reports availability.
//! The java-test extension also ships OSGi/JUnit runtime jars beside its plugin;
//! those companion extensions must be passed to jdtls together or the plugin
//! stays unresolved and never registers its test commands. ASM is special:
//! newer jdtls distributions already provide the same OSGi bundle, so an ASM
//! jar from an unrelated editor extension must never be injected alongside it.
//!
//! Lombok is intentionally NOT a bundle: it loads as a `-javaagent` (see
//! `lombok_javaagent_arg` in `lsp.rs`), which is the correct mechanism for it.

use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use std::sync::{Mutex as StdMutex, OnceLock};

/// A jdtls extension bundle we know how to load.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BundleKind {
    /// `com.microsoft.java.debug.plugin-*.jar` (java-debug → DAP adapter).
    JavaDebug,
    /// `com.microsoft.java.test.plugin-*.jar` (java-test → test discovery/run).
    JavaTest,
}

impl BundleKind {
    /// Jar filename prefix (before the version) for this bundle.
    fn jar_prefix(self) -> &'static str {
        match self {
            BundleKind::JavaDebug => "com.microsoft.java.debug.plugin-",
            BundleKind::JavaTest => "com.microsoft.java.test.plugin-",
        }
    }

    fn config_key(self) -> &'static str {
        match self {
            BundleKind::JavaDebug => "javaDebug",
            BundleKind::JavaTest => "javaTest",
        }
    }
}

/// `package.json -> contributes.javaExtensions` entries shipped by the
/// java-test extension. The test runner and jacoco agent in the same directory
/// are intentionally excluded: they are launched by java-test, not installed
/// as jdtls OSGi bundles for discovery. `org.jacoco.core` and ASM are included
/// when the selected jdtls installation does not already provide those ASM
/// bundles.
const JAVA_TEST_EXTENSION_PREFIXES: &[&str] = &[
    "com.microsoft.java.test.plugin-",
    "junit-",
    "org.apiguardian.api_",
    "org.eclipse.jdt.junit4.runtime_",
    "org.eclipse.jdt.junit5.runtime_",
    "org.eclipse.jdt.junit6.runtime_",
    "org.jacoco.core_",
    "org.opentest4j_",
    "org.objectweb.asm.tree.analysis_",
    "org.objectweb.asm.commons_",
    "org.objectweb.asm.tree_",
    "org.objectweb.asm.util_",
    "org.objectweb.asm_",
];

/// java-test 0.43 declares ASM `[9.7.0,9.8.0)`. Newer jdtls distributions
/// commonly ship ASM 9.10, which does not satisfy that OSGi range, while the
/// installed redhat.java extension carries the compatible 9.7.x bundle group.
const ASM_BUNDLE_PREFIXES: &[&str] = &[
    "org.objectweb.asm.tree.analysis_",
    "org.objectweb.asm.commons_",
    "org.objectweb.asm.tree_",
    "org.objectweb.asm.util_",
    "org.objectweb.asm_",
];

/// User-configured bundle locations. Each entry may be a directory to scan for
/// the versioned jar, or an explicit path to the jar itself. Empty → not
/// configured (that bundle simply is not injected).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JavaBundleConfig {
    /// Directory holding `com.microsoft.java.debug.plugin-*.jar`, or the jar path.
    pub java_debug_path: Option<String>,
    /// Directory holding `com.microsoft.java.test.plugin-*.jar`, or the jar path.
    pub java_test_path: Option<String>,
}
impl JavaBundleConfig {
    fn path_for(&self, kind: BundleKind) -> Option<&str> {
        let raw = match kind {
            BundleKind::JavaDebug => self.java_debug_path.as_deref(),
            BundleKind::JavaTest => self.java_test_path.as_deref(),
        };
        raw.map(str::trim).filter(|value| !value.is_empty())
    }
}

/// Availability of one bundle after probing.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleStatus {
    /// Stable id (`javaDebug` / `javaTest`) so the UI can key on it.
    pub id: String,
    /// Resolved absolute jar path, when found.
    pub path: Option<String>,
    pub available: bool,
}

/// Parse a dotted numeric version (`0.53.1`) into comparable components. Trailing
/// non-numeric suffixes are ignored so `0.53.1.202401` still orders sensibly.
fn numeric_version(raw: &str) -> Vec<u64> {
    raw.split(['.', '-', '_'])
        .map(|part| {
            let digits: String = part.chars().take_while(char::is_ascii_digit).collect();
            digits.parse::<u64>().unwrap_or(0)
        })
        .collect()
}

/// Compare two dotted-numeric versions component-wise (missing → 0).
fn compare_versions(left: &str, right: &str) -> Ordering {
    let left = numeric_version(left);
    let right = numeric_version(right);
    let len = left.len().max(right.len());
    for i in 0..len {
        let l = left.get(i).copied().unwrap_or(0);
        let r = right.get(i).copied().unwrap_or(0);
        match l.cmp(&r) {
            Ordering::Equal => continue,
            other => return other,
        }
    }
    Ordering::Equal
}

/// Resolve the jar for `kind` from a configured path. If the path is a jar file,
/// use it directly; if a directory, pick the highest-versioned
/// `<prefix><version>.jar` inside it. Returns `None` when unset / nothing matches.
fn resolve_bundle_jar(kind: BundleKind, configured: Option<&str>) -> Option<PathBuf> {
    let path = PathBuf::from(configured?.trim());
    if path.is_file() {
        return Some(path);
    }
    if !path.is_dir() {
        return None;
    }
    let prefix = kind.jar_prefix();
    let mut best: Option<(String, PathBuf)> = None;
    for entry in std::fs::read_dir(&path).ok()?.flatten() {
        let entry_path = entry.path();
        let Some(name) = entry_path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Some(rest) = name.strip_prefix(prefix) else {
            continue;
        };
        let Some(version) = rest.strip_suffix(".jar") else {
            continue;
        };
        let better = match &best {
            Some((best_version, _)) => compare_versions(version, best_version) == Ordering::Greater,
            None => true,
        };
        if better {
            best = Some((version.to_string(), entry_path));
        }
    }
    best.map(|(_, jar)| jar)
}

fn is_java_test_extension_jar(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    path.is_file()
        && path.extension().is_some_and(|extension| extension == "jar")
        && JAVA_TEST_EXTENSION_PREFIXES
            .iter()
            .any(|prefix| name.starts_with(prefix))
}

/// Return the java-test OSGi/JUnit companion jars from the selected plugin's
/// directory. A discovered or explicitly configured plugin path points at the
/// same `server` directory as these dependencies, so this also works when the
/// Settings UI stores a single jar path rather than the directory.
fn java_test_extension_jars(configured: Option<&str>, plugin: &Path) -> Vec<PathBuf> {
    let configured_path = configured.map(|value| PathBuf::from(value.trim()));
    let directory = configured_path
        .as_deref()
        .filter(|path| path.is_dir())
        .map(Path::to_path_buf)
        .or_else(|| plugin.parent().map(Path::to_path_buf));
    let Some(directory) = directory else {
        return Vec::new();
    };
    let mut jars: Vec<PathBuf> = std::fs::read_dir(directory)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| is_java_test_extension_jar(path))
        .collect();
    jars.sort_by(|left, right| left.file_name().cmp(&right.file_name()));
    jars
}

fn is_asm_bundle(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    path.is_file()
        && path.extension().is_some_and(|extension| extension == "jar")
        && ASM_BUNDLE_PREFIXES
            .iter()
            .any(|prefix| name.starts_with(prefix))
}

fn jdtls_plugins_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    let mut push = |root: PathBuf| {
        if root.is_dir() && !roots.iter().any(|known| known == &root) {
            roots.push(root);
        }
    };

    if let Some(home) = std::env::var_os("JDTLS_HOME") {
        let home = PathBuf::from(home);
        push(if home.file_name().is_some_and(|name| name == "plugins") {
            home
        } else {
            home.join("plugins")
        });
    }
    if let Some(local) = dirs::data_local_dir() {
        push(local.join("jdtls").join("plugins"));
    }
    if let Some(home) = dirs::home_dir() {
        push(home.join(".local/share/jdtls/plugins"));
        push(home.join("Library/Application Support/jdtls/plugins"));
    }
    roots
}

/// jdtls normally owns the `org.objectweb.asm` bundle in its own `plugins/`
/// directory. Loading another version with the same OSGi symbolic name creates
/// a uses-constraint split (not a normal "newest version wins" choice).
fn jdtls_provides_asm() -> bool {
    jdtls_plugins_roots().into_iter().any(|plugins| {
        std::fs::read_dir(plugins)
            .ok()
            .into_iter()
            .flatten()
            .flatten()
            .any(|entry| is_asm_bundle(&entry.path()))
    })
}

fn compatible_asm_bundle(path: &Path) -> Option<(&'static str, String)> {
    let name = path.file_name().and_then(|name| name.to_str())?;
    if !is_asm_bundle(path) {
        return None;
    }
    let (prefix, version) = ASM_BUNDLE_PREFIXES.iter().find_map(|prefix| {
        name.strip_prefix(prefix)
            .and_then(|rest| rest.strip_suffix(".jar"))
            .map(|version| (*prefix, version.to_string()))
    })?;
    if compare_versions(&version, "9.7.0") == Ordering::Less
        || compare_versions(&version, "9.8.0") != Ordering::Less
    {
        return None;
    }
    Some((prefix, version))
}

/// Keep the newest compatible ASM bundle for each exported package family.
/// The helper is separate from editor-root scanning so its version/range
/// behavior remains unit-testable without depending on a user's extensions.
fn select_compatible_asm_bundles<I>(paths: I) -> Vec<PathBuf>
where
    I: IntoIterator<Item = PathBuf>,
{
    let mut selected: Vec<(&'static str, String, PathBuf)> = Vec::new();
    for path in paths {
        let Some((prefix, version)) = compatible_asm_bundle(&path) else {
            continue;
        };
        match selected.iter_mut().find(|(known, _, _)| *known == prefix) {
            Some((_, known_version, known_path)) => {
                if compare_versions(&version, known_version) == Ordering::Greater {
                    *known_version = version;
                    *known_path = path;
                }
            }
            None => selected.push((prefix, version, path)),
        }
    }
    selected.sort_by(|left, right| left.0.cmp(right.0));
    selected.into_iter().map(|(_, _, path)| path).collect()
}

/// Find compatible ASM OSGi bundles from installed VS Code/Cursor Java
/// extensions as a fallback for a jdtls distribution that does not ship ASM.
/// A jdtls-owned ASM bundle always wins; loading this fallback beside it is
/// what causes the uses-constraint failure this module avoids.
fn discover_compatible_asm_bundles() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    for (_, root) in editor_extension_roots() {
        let Ok(entries) = std::fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten() {
            let plugins = entry.path().join("server").join("plugins");
            let Ok(plugin_entries) = std::fs::read_dir(plugins) else {
                continue;
            };
            candidates.extend(plugin_entries.flatten().map(|entry| entry.path()));
        }
    }
    select_compatible_asm_bundles(candidates)
}

/// Resolve the absolute jar paths to inject into `initializationOptions.bundles`.
/// java-debug is followed by the java-test extension dependencies and plugin,
/// matching the extension's `contributes.javaExtensions` contract. Missing
/// bundles are simply omitted.
pub fn resolve_bundle_jars(config: &JavaBundleConfig) -> Vec<String> {
    let mut jars = Vec::new();
    if let Some(debug) = resolve_bundle_jar(
        BundleKind::JavaDebug,
        config.path_for(BundleKind::JavaDebug),
    ) {
        jars.push(debug);
    }
    if let Some(test) =
        resolve_bundle_jar(BundleKind::JavaTest, config.path_for(BundleKind::JavaTest))
    {
        let jdtls_provides_asm = jdtls_provides_asm();
        let mut has_extension_asm = false;
        for jar in java_test_extension_jars(config.path_for(BundleKind::JavaTest), &test) {
            if jar != test && (!is_asm_bundle(&jar) || !jdtls_provides_asm) {
                has_extension_asm |= is_asm_bundle(&jar);
                jars.push(jar);
            }
        }
        if !jdtls_provides_asm && !has_extension_asm {
            jars.extend(discover_compatible_asm_bundles());
        }
        // Keep the provider plugin last, as listed by the upstream extension.
        jars.push(test);
    }
    jars.into_iter()
        .map(|jar| jar.to_string_lossy().into_owned())
        .collect()
}

/// Probe each known bundle against `config` for the Settings UI.
pub fn probe_bundles(config: &JavaBundleConfig) -> Vec<BundleStatus> {
    [BundleKind::JavaDebug, BundleKind::JavaTest]
        .into_iter()
        .map(|kind| {
            let path = resolve_bundle_jar(kind, config.path_for(kind))
                .map(|jar| jar.to_string_lossy().into_owned());
            BundleStatus {
                id: kind.config_key().to_string(),
                available: path.is_some(),
                path,
            }
        })
        .collect()
}

static CONFIGURED_JAVA_BUNDLES: OnceLock<StdMutex<JavaBundleConfig>> = OnceLock::new();

fn configured_lock() -> &'static StdMutex<JavaBundleConfig> {
    CONFIGURED_JAVA_BUNDLES.get_or_init(|| StdMutex::new(JavaBundleConfig::default()))
}

/// Store the Settings-configured bundle paths (applied on the next jdtls start).
pub fn set_configured_bundles(config: JavaBundleConfig) {
    if let Ok(mut guard) = configured_lock().lock() {
        *guard = config;
    }
}

/// Current bundle config (default when unset).
pub fn get_configured_bundles() -> JavaBundleConfig {
    configured_lock()
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_default()
}

/// Absolute jar paths for `initializationOptions.bundles`, from stored config.
pub fn configured_bundle_jars() -> Vec<String> {
    resolve_bundle_jars(&get_configured_bundles())
}

/// A jdtls extension jar found on disk that the user could adopt without any
/// manual path hunting or download (the 80% "install is complex" case: the jar
/// already ships inside a VS Code / Cursor / VSCodium extension).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredBundle {
    /// `javaDebug` | `javaTest`, matching `BundleStatus.id`.
    pub id: String,
    /// Absolute path to the versioned plugin jar.
    pub path: String,
    /// Parsed dotted version (`0.53.2`) for display / picking the newest.
    pub version: String,
    /// Human label for where it came from (e.g. `vscode: vscjava.vscode-java-debug`).
    pub source: String,
}

/// Editor extension roots that commonly contain the java-debug / java-test
/// plugin jars, cross-platform. VS Code, VSCodium, Cursor, and the Insiders
/// build all use `<home>/.<editor>/extensions` on every OS.
fn editor_extension_roots() -> Vec<(&'static str, PathBuf)> {
    let mut out = Vec::new();
    let Some(home) = dirs::home_dir() else {
        return out;
    };
    for (label, rel) in [
        ("vscode", ".vscode/extensions"),
        ("vscode-insiders", ".vscode-insiders/extensions"),
        ("vscode-server", ".vscode-server/extensions"),
        ("cursor", ".cursor/extensions"),
        ("vscodium", ".vscode-oss/extensions"),
        ("windsurf", ".windsurf/extensions"),
    ] {
        out.push((label, home.join(rel)));
    }
    out
}

/// Scan the known editor extension roots for the newest plugin jar of each
/// bundle kind. One entry per (source, kind); newest version per source wins.
/// Pure filesystem scan — never downloads, never mutates config.
pub fn discover_bundles() -> Vec<DiscoveredBundle> {
    let mut out: Vec<DiscoveredBundle> = Vec::new();
    for (label, root) in editor_extension_roots() {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let ext_dir = entry.path();
            if !ext_dir.is_dir() {
                continue;
            }
            // Extension dirs are named `publisher.name-version`; the jars live
            // under `server/`. Only the java debug/test extensions carry them.
            let server_dir = ext_dir.join("server");
            if !server_dir.is_dir() {
                continue;
            }
            let ext_name = ext_dir
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();
            for kind in [BundleKind::JavaDebug, BundleKind::JavaTest] {
                if let Some((version, path)) = newest_jar_in_dir(&server_dir, kind.jar_prefix()) {
                    let source = format!("{label}: {ext_name}");
                    push_newest_discovery(&mut out, kind, version, path, source);
                }
            }
        }
    }
    out
}

/// Highest-versioned `<prefix><version>.jar` in `dir`, or None.
fn newest_jar_in_dir(dir: &Path, prefix: &str) -> Option<(String, PathBuf)> {
    let mut best: Option<(String, PathBuf)> = None;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Some(rest) = name.strip_prefix(prefix) else {
            continue;
        };
        let Some(version) = rest.strip_suffix(".jar") else {
            continue;
        };
        let better = match &best {
            Some((best_version, _)) => compare_versions(version, best_version) == Ordering::Greater,
            None => true,
        };
        if better {
            best = Some((version.to_string(), path));
        }
    }
    best
}

/// Insert a discovery, keeping only the newest jar per (id, source).
fn push_newest_discovery(
    out: &mut Vec<DiscoveredBundle>,
    kind: BundleKind,
    version: String,
    path: PathBuf,
    source: String,
) {
    let id = kind.config_key().to_string();
    if let Some(existing) = out.iter_mut().find(|d| d.id == id && d.source == source) {
        if compare_versions(&version, &existing.version) == Ordering::Greater {
            existing.version = version;
            existing.path = path.to_string_lossy().into_owned();
        }
        return;
    }
    out.push(DiscoveredBundle {
        id,
        path: path.to_string_lossy().into_owned(),
        version,
        source,
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(dir: &Path, name: &str) {
        std::fs::write(dir.join(name), b"jar").unwrap();
    }

    #[test]
    fn compares_dotted_versions_numerically_not_lexically() {
        assert_eq!(compare_versions("0.53.1", "0.9.0"), Ordering::Greater);
        assert_eq!(compare_versions("0.40.0", "0.40.0"), Ordering::Equal);
        assert_eq!(compare_versions("1.0", "1.0.1"), Ordering::Less);
    }

    #[test]
    fn picks_highest_version_jar_in_a_directory() {
        let dir = tempfile::tempdir().unwrap();
        touch(dir.path(), "com.microsoft.java.debug.plugin-0.9.0.jar");
        touch(dir.path(), "com.microsoft.java.debug.plugin-0.53.1.jar");
        touch(dir.path(), "com.microsoft.java.debug.plugin-0.40.0.jar");
        touch(dir.path(), "unrelated.jar");

        let jar = resolve_bundle_jar(BundleKind::JavaDebug, Some(dir.path().to_str().unwrap()))
            .expect("resolves a jar");
        assert!(
            jar.to_string_lossy()
                .ends_with("com.microsoft.java.debug.plugin-0.53.1.jar")
        );
    }

    #[test]
    fn accepts_an_explicit_jar_path() {
        let dir = tempfile::tempdir().unwrap();
        touch(dir.path(), "com.microsoft.java.test.plugin-0.41.1.jar");
        let explicit = dir.path().join("com.microsoft.java.test.plugin-0.41.1.jar");
        let jar = resolve_bundle_jar(BundleKind::JavaTest, Some(explicit.to_str().unwrap()))
            .expect("explicit jar resolves");
        assert_eq!(jar, explicit);
    }

    #[test]
    fn resolve_and_probe_reflect_configured_paths() {
        let dir = tempfile::tempdir().unwrap();
        touch(dir.path(), "com.microsoft.java.debug.plugin-0.52.0.jar");
        // Only java-debug configured; java-test unset.
        let config = JavaBundleConfig {
            java_debug_path: Some(dir.path().to_string_lossy().into_owned()),
            java_test_path: Some("   ".into()),
        };
        let jars = resolve_bundle_jars(&config);
        assert_eq!(
            jars.len(),
            1,
            "only java-debug should resolve, got {jars:?}"
        );
        assert!(jars[0].ends_with("com.microsoft.java.debug.plugin-0.52.0.jar"));

        let statuses = probe_bundles(&config);
        assert_eq!(statuses.len(), 2);
        let debug = statuses.iter().find(|s| s.id == "javaDebug").unwrap();
        assert!(debug.available && debug.path.is_some());
        let test = statuses.iter().find(|s| s.id == "javaTest").unwrap();
        assert!(!test.available && test.path.is_none());
    }

    #[test]
    fn resolves_java_test_companion_extensions_and_excludes_runtime_helpers() {
        let dir = tempfile::tempdir().unwrap();
        touch(dir.path(), "com.microsoft.java.test.plugin-0.43.0.jar");
        touch(
            dir.path(),
            "org.eclipse.jdt.junit4.runtime_1.3.100.v20231214-1952.jar",
        );
        touch(
            dir.path(),
            "org.eclipse.jdt.junit5.runtime_1.1.300.v20231214-1952.jar",
        );
        touch(
            dir.path(),
            "org.eclipse.jdt.junit6.runtime_1.0.0.v20251112-1701.jar",
        );
        touch(dir.path(), "junit-platform-launcher_1.11.0.jar");
        touch(dir.path(), "org.jacoco.core_0.8.12.202403310830.jar");
        touch(
            dir.path(),
            "com.microsoft.java.test.runner-jar-with-dependencies.jar",
        );
        touch(dir.path(), "jacocoagent.jar");

        let plugin = dir.path().join("com.microsoft.java.test.plugin-0.43.0.jar");
        let jars = resolve_bundle_jars(&JavaBundleConfig {
            java_debug_path: None,
            java_test_path: Some(plugin.to_string_lossy().into_owned()),
        });

        assert!(jars.iter().any(|jar| {
            jar.ends_with("org.eclipse.jdt.junit4.runtime_1.3.100.v20231214-1952.jar")
        }));
        assert!(jars.iter().any(|jar| {
            jar.ends_with("org.eclipse.jdt.junit5.runtime_1.1.300.v20231214-1952.jar")
        }));
        assert!(jars.iter().any(|jar| {
            jar.ends_with("org.eclipse.jdt.junit6.runtime_1.0.0.v20251112-1701.jar")
        }));
        assert!(
            jars.iter()
                .any(|jar| jar.ends_with("junit-platform-launcher_1.11.0.jar"))
        );
        assert!(
            jars.iter()
                .any(|jar| jar.ends_with("org.jacoco.core_0.8.12.202403310830.jar"))
        );
        assert!(
            jars.last()
                .is_some_and(|jar| jar.ends_with("com.microsoft.java.test.plugin-0.43.0.jar"))
        );
        assert!(
            !jars
                .iter()
                .any(|jar| jar.contains("test.runner-jar-with-dependencies"))
        );
        assert!(!jars.iter().any(|jar| jar.ends_with("jacocoagent.jar")));
    }

    #[test]
    fn selects_newest_asm_bundle_per_family_with_java_test_range() {
        let dir = tempfile::tempdir().unwrap();
        let names = [
            "org.objectweb.asm_9.7.0.jar",
            "org.objectweb.asm_9.7.1.jar",
            "org.objectweb.asm_9.8.0.jar",
            "org.objectweb.asm.commons_9.7.1.jar",
            "org.objectweb.asm.tree_9.6.0.jar",
            "org.objectweb.asm.util_9.7.1.jar",
            "unrelated_9.7.1.jar",
        ];
        for name in names {
            touch(dir.path(), name);
        }

        let selected = select_compatible_asm_bundles(
            std::fs::read_dir(dir.path())
                .unwrap()
                .flatten()
                .map(|entry| entry.path()),
        );
        assert_eq!(selected.len(), 3);
        assert!(
            selected
                .iter()
                .any(|path| path.ends_with("org.objectweb.asm_9.7.1.jar"))
        );
        assert!(
            selected
                .iter()
                .any(|path| path.ends_with("org.objectweb.asm.commons_9.7.1.jar"))
        );
        assert!(
            selected
                .iter()
                .any(|path| path.ends_with("org.objectweb.asm.util_9.7.1.jar"))
        );
        assert!(
            !selected
                .iter()
                .any(|path| path.to_string_lossy().contains("9.8.0"))
        );
    }

    #[test]
    fn missing_config_yields_no_bundles() {
        assert!(resolve_bundle_jars(&JavaBundleConfig::default()).is_empty());
        assert!(resolve_bundle_jar(BundleKind::JavaDebug, None).is_none());
        assert!(resolve_bundle_jar(BundleKind::JavaDebug, Some("/no/such/dir")).is_none());
    }

    #[test]
    fn newest_jar_in_dir_picks_highest_and_ignores_others() {
        let dir = tempfile::tempdir().unwrap();
        touch(dir.path(), "com.microsoft.java.debug.plugin-0.40.0.jar");
        touch(dir.path(), "com.microsoft.java.debug.plugin-0.53.2.jar");
        touch(dir.path(), "com.microsoft.java.test.plugin-0.43.1.jar");
        touch(dir.path(), "noise.jar");

        let (version, path) = newest_jar_in_dir(dir.path(), BundleKind::JavaDebug.jar_prefix())
            .expect("finds debug jar");
        assert_eq!(version, "0.53.2");
        assert!(
            path.to_string_lossy()
                .ends_with("com.microsoft.java.debug.plugin-0.53.2.jar")
        );

        // A prefix with no match yields nothing rather than a wrong jar.
        assert!(newest_jar_in_dir(dir.path(), "com.example.absent-").is_none());
    }

    #[test]
    fn push_newest_discovery_keeps_newest_per_source() {
        let dir = tempfile::tempdir().unwrap();
        let mut out = Vec::new();
        push_newest_discovery(
            &mut out,
            BundleKind::JavaDebug,
            "0.52.0".into(),
            dir.path()
                .join("com.microsoft.java.debug.plugin-0.52.0.jar"),
            "vscode: vscjava.vscode-java-debug-0.58.0".into(),
        );
        // Same source, newer version → replaces in place (no duplicate row).
        push_newest_discovery(
            &mut out,
            BundleKind::JavaDebug,
            "0.53.2".into(),
            dir.path()
                .join("com.microsoft.java.debug.plugin-0.53.2.jar"),
            "vscode: vscjava.vscode-java-debug-0.58.0".into(),
        );
        // A different source is a distinct row the user can choose between.
        push_newest_discovery(
            &mut out,
            BundleKind::JavaDebug,
            "0.53.2".into(),
            dir.path()
                .join("com.microsoft.java.debug.plugin-0.53.2.jar"),
            "cursor: vscjava.vscode-java-debug-0.58.5".into(),
        );
        assert_eq!(out.len(), 2);
        assert!(
            out.iter()
                .all(|d| d.id == "javaDebug" && d.version == "0.53.2")
        );
    }
}
