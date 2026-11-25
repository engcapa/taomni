use std::collections::BTreeSet;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use taomni_plugin_api::services::{
    CAPTURE_SCREEN_PERMISSION, CAPTURE_STILL_SERVICE, CoreServiceError, FIXED_KEY_SERVICE,
    FixedKeyId, HostInstanceId, MFA_DATA_KEY_ID,
};
use taomni_profile_locks::PluginSlug;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FixedKeyOwner {
    pub slug: &'static str,
    pub id: &'static str,
    pub kind: &'static str,
    pub label: &'static str,
}

pub const MFA_FIXED_KEY_OWNER: FixedKeyOwner = FixedKeyOwner {
    slug: "mfa",
    id: MFA_DATA_KEY_ID,
    kind: "mfa_secret",
    label: "MFA Data Key",
};

fn owner(key: &str) -> Option<FixedKeyOwner> {
    (key == MFA_FIXED_KEY_OWNER.id).then_some(MFA_FIXED_KEY_OWNER)
}

/// This value must be created by trusted core code *after* signature, package
/// identity and handshake validation. It is deliberately not Deserialize.
/// Construction validates grants; construction alone authenticates no process.
#[derive(Clone, Debug)]
pub struct VerifiedHostGrants {
    slug: PluginSlug,
    permissions: BTreeSet<String>,
    fixed_keys: BTreeSet<String>,
}

impl VerifiedHostGrants {
    pub fn service_capabilities(&self) -> taomni_plugin_api::services::ServiceCapabilities {
        let mut capabilities = taomni_plugin_api::services::ServiceCapabilities::default();
        if self.permissions.contains(FIXED_KEY_SERVICE) && !self.fixed_keys.is_empty() {
            capabilities.0.insert(
                FIXED_KEY_SERVICE.into(),
                taomni_plugin_api::services::SERVICE_VERSION,
            );
        }
        if self.permissions.contains(CAPTURE_SCREEN_PERMISSION) {
            capabilities.0.insert(
                CAPTURE_STILL_SERVICE.into(),
                taomni_plugin_api::services::SERVICE_VERSION,
            );
        }
        capabilities
    }

    pub fn from_verified_manifest(
        slug: PluginSlug,
        permissions: BTreeSet<String>,
        fixed_keys: BTreeSet<String>,
    ) -> Result<Self, CoreServiceError> {
        for key in &fixed_keys {
            if !permissions.contains(FIXED_KEY_SERVICE)
                || owner(key).is_none_or(|owner| owner.slug != slug.as_str())
            {
                return Err(CoreServiceError::PermissionDenied);
            }
        }
        Ok(Self {
            slug,
            permissions,
            fixed_keys,
        })
    }

    pub fn bind_authenticated_transport(self, instance: HostInstanceId) -> AuthorizedHost {
        AuthorizedHost {
            instance,
            grants: self,
            terminated: Arc::new(AtomicBool::new(false)),
        }
    }
}

/// Identity comes from the core's transport owner, never ServiceRequest data.
#[derive(Clone, Debug)]
pub struct AuthorizedHost {
    instance: HostInstanceId,
    grants: VerifiedHostGrants,
    // Shared by the runtime, queued operations and retired transports. No
    // unbounded global tombstone table is needed after a transport is reaped.
    terminated: Arc<AtomicBool>,
}

impl AuthorizedHost {
    pub fn termination_confirmed(&self) -> bool {
        self.terminated.load(Ordering::Acquire)
    }
    pub(crate) fn mark_terminated(&self) {
        self.terminated.store(true, Ordering::Release);
    }
    pub fn instance(&self) -> &HostInstanceId {
        &self.instance
    }
    pub fn slug(&self) -> &PluginSlug {
        &self.grants.slug
    }

    pub fn authorize_screen_capture(&self) -> Result<(), CoreServiceError> {
        if self.grants.permissions.contains(CAPTURE_SCREEN_PERMISSION) {
            Ok(())
        } else {
            Err(CoreServiceError::PermissionDenied)
        }
    }

    pub fn fixed_key_owner(&self, key: &FixedKeyId) -> Result<FixedKeyOwner, CoreServiceError> {
        if !self.grants.permissions.contains(FIXED_KEY_SERVICE)
            || !self.grants.fixed_keys.contains(key.as_str())
        {
            return Err(CoreServiceError::PermissionDenied);
        }
        owner(key.as_str())
            .filter(|owner| owner.slug == self.grants.slug.as_str())
            .ok_or(CoreServiceError::PermissionDenied)
    }
}
