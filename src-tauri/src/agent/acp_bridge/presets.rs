use super::config::AcpProfileConfig;

pub const GROK_PROFILE_ID: &str = "grok";
pub const GROK_PROFILE_NAME: &str = "Grok CLI";
pub const GROK_COMMAND: &str = "grok";

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
        args: vec!["agent".into(), "stdio".into()],
        auth_method_id: None,
        proxy_mode: "inherit".into(),
        proxy_session_id: None,
        proxy_url: None,
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
        assert_eq!(profile.args, ["agent", "stdio"]);
        assert!(profile.auth_method_id.is_none());
    }
}
