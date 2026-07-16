use super::config::{AcpProfileCapabilities, AcpProfileConfig};

pub const GROK_PROFILE_ID: &str = "grok";
pub const GROK_PROFILE_NAME: &str = "Grok CLI";
pub const GROK_COMMAND: &str = "grok";
pub const GROK_ACP_ARGS: [&str; 5] = [
    "--permission-mode",
    "default",
    "agent",
    "--no-leader",
    "stdio",
];

/// Built-in ACP profile for the locally authenticated Grok CLI.
///
/// The preset is deliberately disabled. Enabling it never creates an xAI API
/// provider or stores an xAI credential in Taomni; authentication remains
/// entirely owned by the user's local `grok` installation.
pub fn grok_profile() -> AcpProfileConfig {
    AcpProfileConfig {
        id: GROK_PROFILE_ID.into(),
        name: GROK_PROFILE_NAME.into(),
        enabled: false,
        command: GROK_COMMAND.into(),
        args: GROK_ACP_ARGS.iter().map(|arg| (*arg).into()).collect(),
        capabilities: AcpProfileCapabilities {
            image_generation: Some(true),
            video_generation: Some(true),
        },
        auth_method_id: None,
        proxy_mode: "inherit".into(),
        proxy_session_id: None,
        proxy_url: None,
    }
}

/// Apply Taomni's fail-closed Grok launch policy while preserving any extra
/// agent arguments a user has configured. The explicit global flag overrides
/// a local `ui.permission_mode = "always-approve"`; `--no-leader` keeps a
/// per-chat ACP process from reusing a leader with stale permission state.
///
/// Only an actual `grok agent …` invocation is rewritten. A malformed or
/// intentionally custom non-agent profile remains untouched so this helper
/// cannot silently turn it into a different command shape.
pub(super) fn secure_grok_acp_args(args: &[String]) -> Vec<String> {
    let Some(agent_index) = args.iter().position(|arg| arg == "agent") else {
        return args.to_vec();
    };

    let mut result = vec!["--permission-mode".into(), "default".into()];
    append_without_permission_overrides(&mut result, &args[..agent_index]);
    result.push("agent".into());
    result.push("--no-leader".into());
    append_without_permission_overrides(&mut result, &args[agent_index + 1..]);
    result
}

/// Drop every command-line setting that can bypass or pre-authorize a native
/// Grok tool call. The bridge owns those choices through ACP permission
/// requests, so saved profile arguments cannot silently approve an action.
fn append_without_permission_overrides(result: &mut Vec<String>, args: &[String]) {
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        if arg == "--permission-mode" || arg == "--allow" {
            index += 2;
        } else if arg == "--always-approve" || arg == "--leader" || arg == "--no-leader" {
            index += 1;
        } else if arg.starts_with("--permission-mode=")
            || arg.starts_with("--allow=")
            || arg.starts_with("--always-approve=")
        {
            index += 1;
        } else {
            result.push(arg.clone());
            index += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grok_preset_uses_acp_stdio_and_stays_disabled() {
        let profile = grok_profile();
        assert_eq!(profile.id, "grok");
        assert!(!profile.enabled);
        assert_eq!(profile.command, "grok");
        assert_eq!(profile.args, GROK_ACP_ARGS);
        assert!(profile.supports_image_generation());
        assert!(profile.supports_video_generation());
        assert!(profile.auth_method_id.is_none());
    }

    #[test]
    fn grok_launch_policy_removes_saved_permission_bypasses_and_preapprovals() {
        assert_eq!(
            secure_grok_acp_args(&[
                "--permission-mode".into(),
                "bypassPermissions".into(),
                "--allow".into(),
                "Bash(*)".into(),
                "agent".into(),
                "--leader".into(),
                "--always-approve".into(),
                "--allow=Write(*)".into(),
                "--always-approve=true".into(),
                "stdio".into(),
            ]),
            GROK_ACP_ARGS,
        );
    }
}
