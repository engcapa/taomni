use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppLaunchPreparation {
    /// Absolute directory inherited by the trace launcher, preparation shell,
    /// target application, and every descendant.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub working_directory: String,
    /// Literal environment overrides. Values are not shell-expanded.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub environment: BTreeMap<String, String>,
    /// Shell program evaluated before the final target is exec'd.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub pre_command: String,
    /// POSIX-compatible interpreter used for the preparation wrapper.
    #[serde(default, skip_serializing_if = "AppLaunchShell::is_sh")]
    pub shell: AppLaunchShell,
}

impl AppLaunchPreparation {
    pub fn is_empty(&self) -> bool {
        self.working_directory.is_empty()
            && self.environment.is_empty()
            && self.pre_command.is_empty()
            && self.shell.is_sh()
    }

    pub(super) fn validate(&self, profile_name: &str, app_path: &str) -> Result<(), String> {
        if !self.working_directory.is_empty() && !is_absolute_launch_path(&self.working_directory) {
            return Err(format!(
                "Profile '{profile_name}' application '{app_path}' working directory must be absolute"
            ));
        }
        if self.pre_command.len() > 64 * 1024 {
            return Err(format!(
                "Profile '{profile_name}' application '{app_path}' preparation command exceeds 64 KiB"
            ));
        }
        if self.environment.len() > 128 {
            return Err(format!(
                "Profile '{profile_name}' application '{app_path}' has more than 128 environment variables"
            ));
        }
        for (name, value) in &self.environment {
            if !valid_environment_name(name) {
                return Err(format!(
                    "Profile '{profile_name}' application '{app_path}' has invalid environment variable name '{name}'"
                ));
            }
            if value.len() > 64 * 1024 {
                return Err(format!(
                    "Profile '{profile_name}' application '{app_path}' environment variable '{name}' exceeds 64 KiB"
                ));
            }
        }
        Ok(())
    }
}

/// Launch preparation is a Linux/POSIX feature, but its configuration is
/// persisted and validated on every platform. `Path::is_absolute()` on
/// Windows treats `/workspace/app` as root-relative rather than absolute,
/// even though that is a valid POSIX path for the Linux backend.
pub(super) fn is_absolute_launch_path(path: &str) -> bool {
    path.starts_with('/') || Path::new(path).is_absolute()
}

pub(super) fn valid_environment_name(name: &str) -> bool {
    let mut characters = name.chars();
    matches!(characters.next(), Some('_' | 'A'..='Z' | 'a'..='z'))
        && characters.all(|character| matches!(character, '_' | '0'..='9' | 'A'..='Z' | 'a'..='z'))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum AppLaunchShell {
    #[default]
    Sh,
    Bash,
}

impl AppLaunchShell {
    pub(super) fn is_sh(&self) -> bool {
        matches!(self, Self::Sh)
    }

    pub fn command_name(self) -> &'static str {
        match self {
            Self::Sh => "sh",
            Self::Bash => "bash",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum AppLaunchMode {
    #[default]
    Desktop,
    Terminal,
}

impl AppLaunchMode {
    pub(super) fn is_desktop(&self) -> bool {
        matches!(self, Self::Desktop)
    }
}
