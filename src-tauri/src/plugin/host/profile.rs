//! Core-controlled storage ownership is acknowledged before host activation.
use super::HostProcessError;
use std::process::Command;
use taomni_plugin_api::services::{HOST_PROFILE_ENV, HostProfileContext, ProfileGeneration};
use taomni_profile_locks::{PluginSlug, ProfileRoot};

#[derive(Clone, Debug)]
pub struct HostProfileConfig {
    root: ProfileRoot,
    context: HostProfileContext,
}

impl HostProfileConfig {
    pub fn new(root: ProfileRoot, owner: PluginSlug, generation: ProfileGeneration) -> Self {
        Self {
            root,
            context: HostProfileContext {
                owner: owner.as_str().into(),
                generation,
            },
        }
    }

    pub(super) fn configure(
        &self,
        command: &mut Command,
        plugin_id: &str,
    ) -> Result<(), HostProcessError> {
        if plugin_id.strip_prefix("taomni-plugin-") != Some(self.context.owner.as_str()) {
            return Err(HostProcessError::Handshake(
                "profile owner differs from plugin identity".into(),
            ));
        }
        command.env(
            HOST_PROFILE_ENV,
            serde_json::json!({"root":self.root.path(), "context":self.context}).to_string(),
        );
        Ok(())
    }

    pub(super) fn context(&self) -> &HostProfileContext {
        &self.context
    }
}

pub(super) fn validate_profile_ack(
    requested: Option<&HostProfileContext>,
    received: Option<&HostProfileContext>,
) -> Result<(), HostProcessError> {
    if requested != received {
        return Err(HostProcessError::Handshake(
            "host did not acknowledge its exact profile/data ownership".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_claim_without_matching_generation_or_owner_never_activates_a_host() {
        let dir = tempfile::tempdir().unwrap();
        let root = ProfileRoot::prepare(dir.path()).unwrap();
        let generation = ProfileGeneration::parse("a1234567-1234-1234-1234-123456789abc").unwrap();
        let profile = HostProfileConfig::new(root, PluginSlug::parse("mfa").unwrap(), generation);
        assert!(validate_profile_ack(Some(profile.context()), None).is_err());
        assert!(validate_profile_ack(None, Some(profile.context())).is_err());
        assert!(validate_profile_ack(Some(profile.context()), Some(profile.context())).is_ok());
        assert!(validate_profile_ack(None, None).is_ok());
        let mut wrong = profile.context().clone();
        wrong.owner = "other".into();
        assert!(validate_profile_ack(Some(profile.context()), Some(&wrong)).is_err());
        wrong = profile.context().clone();
        wrong.generation =
            ProfileGeneration::parse("b1234567-1234-1234-1234-123456789abc").unwrap();
        assert!(validate_profile_ack(Some(profile.context()), Some(&wrong)).is_err());
        let mut command = Command::new("unused-unit-fixture");
        assert!(
            profile
                .configure(&mut command, "taomni-plugin-other")
                .is_err()
        );
        profile
            .configure(&mut command, "taomni-plugin-mfa")
            .unwrap();
        let value = command
            .get_envs()
            .find(|(name, _)| *name == HOST_PROFILE_ENV)
            .unwrap()
            .1
            .unwrap();
        let value: serde_json::Value = serde_json::from_str(value.to_str().unwrap()).unwrap();
        assert_eq!(
            value["context"],
            serde_json::to_value(profile.context()).unwrap()
        );
    }
}
