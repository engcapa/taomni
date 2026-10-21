use crate::lsp::configuration_state::CONFIGURED_JAVA_SETTINGS;
use crate::sdk::JavaRuntimeConfiguration;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use serde_json::json;
use std::sync::Mutex as StdMutex;

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
pub(in crate::lsp) fn non_empty_or_null(value: Option<&str>) -> Value {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => Value::String(value.to_string()),
        None => Value::Null,
    }
}
impl JavaLanguageSettings {
    /// Build the `java` object for `settings.java` (initialize + didChangeConfiguration).
    /// `runtimes` is threaded in separately because it is backend-owned per project.
    pub(in crate::lsp) fn to_java_settings(&self, runtimes: &[JavaRuntimeConfiguration]) -> Value {
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
pub(in crate::lsp) fn configured_java_settings_lock()
-> &'static StdMutex<Option<JavaLanguageSettings>> {
    CONFIGURED_JAVA_SETTINGS.get_or_init(|| StdMutex::new(None))
}

pub(in crate::lsp) fn set_configured_java_settings(settings: Option<JavaLanguageSettings>) {
    if let Ok(mut guard) = configured_java_settings_lock().lock() {
        *guard = settings;
    }
}

/// Effective `java.*` settings (Settings override or defaults).
pub(in crate::lsp) fn get_configured_java_settings() -> JavaLanguageSettings {
    configured_java_settings_lock()
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
        .unwrap_or_default()
}
