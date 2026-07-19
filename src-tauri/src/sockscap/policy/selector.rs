//! Immutable routing-profile selection for the production flow runtime.
//!
//! A platform adapter may either provide process/application attribution or an
//! already-authenticated per-profile queue binding.  A queue binding is
//! authoritative only after this selector confirms that it belongs to the
//! current immutable profile snapshot; an unknown or disabled id never falls
//! back to another profile.

use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;

use crate::sockscap::types::{
    AppSelectorKind, ProfileScope, RoutingProfileDraft, detect_profile_conflicts,
    validate_profile_draft,
};

pub const MAX_PROFILE_SELECTOR_PROFILES: usize = 256;
pub const MAX_PROFILE_SELECTOR_BINDINGS: usize = 4_096;

/// How the capture plane bound a flow to the policy snapshot.
///
/// `TrustedQueue` must only be constructed from an authenticated adapter side
/// channel for the same capture generation.  It must never be populated from
/// webview, packet, DNS, or peer-controlled data.
#[derive(Clone, Copy, Default, PartialEq, Eq)]
pub enum ProfileSelectionBinding<'a> {
    /// Select from verified process/application attribution. Whether global is
    /// a valid fallback is controlled independently by `intent`.
    #[default]
    Attributed,
    /// Select the exact profile attached to a trusted, isolated capture queue.
    TrustedQueue { profile_id: &'a str },
}

/// Whether this capture source permits global fallback after specific matching.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GlobalFallbackPolicy {
    Allow,
    Deny,
}

/// Capture-time matching intent, carried separately from identity evidence.
///
/// Making this explicit prevents an application/PID capture path from silently
/// becoming global merely because attribution was missing, stale, or unmatched.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ProfileSelectionIntent<'a> {
    AllowGlobalFallback,
    RequireApplication,
    RequireRuntimeProcess,
    RequireAnySpecific,
    TrustedProfile {
        profile_id: &'a str,
        inherited_child: bool,
    },
}

impl ProfileSelectionIntent<'_> {
    pub const fn global_fallback_policy(self) -> GlobalFallbackPolicy {
        match self {
            Self::AllowGlobalFallback => GlobalFallbackPolicy::Allow,
            Self::RequireApplication
            | Self::RequireRuntimeProcess
            | Self::RequireAnySpecific
            | Self::TrustedProfile { .. } => GlobalFallbackPolicy::Deny,
        }
    }
}

impl Default for ProfileSelectionIntent<'_> {
    /// A missing intent is fail-closed. Callers that legitimately capture the
    /// global plane must opt in with `AllowGlobalFallback`.
    fn default() -> Self {
        Self::RequireAnySpecific
    }
}

impl fmt::Debug for ProfileSelectionIntent<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AllowGlobalFallback => formatter.write_str("AllowGlobalFallback"),
            Self::RequireApplication => formatter.write_str("RequireApplication"),
            Self::RequireRuntimeProcess => formatter.write_str("RequireRuntimeProcess"),
            Self::RequireAnySpecific => formatter.write_str("RequireAnySpecific"),
            Self::TrustedProfile {
                inherited_child, ..
            } => formatter
                .debug_struct("TrustedProfile")
                .field("profile_id", &"<redacted>")
                .field("inherited_child", inherited_child)
                .finish(),
        }
    }
}

impl fmt::Debug for ProfileSelectionBinding<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Attributed => formatter.write_str("Attributed"),
            Self::TrustedQueue { .. } => {
                formatter.write_str("TrustedQueue { profile_id: <redacted> }")
            }
        }
    }
}

/// Exact runtime-process incarnation supplied by a platform adapter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RuntimeProcessIdentity {
    pub pid: u32,
    pub process_start_time: u64,
}

/// Stable application identity supplied by a platform adapter.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct ApplicationIdentity<'a> {
    pub kind: AppSelectorKind,
    pub value: &'a str,
}

impl fmt::Debug for ApplicationIdentity<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ApplicationIdentity")
            .field("kind", &self.kind)
            .field("value", &"<redacted>")
            .finish()
    }
}

/// Minimal typed view that ingress/`FlowDescriptor` converts into.
///
/// Keeping this view independent from the packet/stream ingress module lets
/// profile selection remain deterministic and unit-testable while that module
/// evolves.
#[derive(Clone, Copy, Default, PartialEq, Eq)]
pub struct ProfileSelectionInput<'a> {
    pub binding: ProfileSelectionBinding<'a>,
    pub intent: ProfileSelectionIntent<'a>,
    pub runtime_process: Option<RuntimeProcessIdentity>,
    pub application: Option<ApplicationIdentity<'a>>,
}

impl fmt::Debug for ProfileSelectionInput<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProfileSelectionInput")
            .field("binding", &self.binding)
            .field("intent", &self.intent)
            .field("has_runtime_process", &self.runtime_process.is_some())
            .field("has_application", &self.application.is_some())
            .finish()
    }
}

/// Evidence used to choose the immutable profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProfileSelectionSource {
    TrustedQueue,
    RuntimeProcess,
    Application,
    GlobalFallback,
}

/// One selected immutable profile.
#[derive(Clone, PartialEq, Eq)]
pub struct ProfileSelection {
    profile: Arc<RoutingProfileDraft>,
    source: ProfileSelectionSource,
}

impl ProfileSelection {
    pub fn profile(&self) -> &RoutingProfileDraft {
        &self.profile
    }

    pub fn profile_arc(&self) -> Arc<RoutingProfileDraft> {
        self.profile.clone()
    }

    pub fn profile_id(&self) -> &str {
        &self.profile.id
    }

    pub fn source(&self) -> ProfileSelectionSource {
        self.source
    }
}

impl fmt::Debug for ProfileSelection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProfileSelection")
            .field("profile_id", &self.profile.id)
            .field("priority", &self.profile.priority)
            .field("source", &self.source)
            .finish()
    }
}

/// Fail-closed construction/selection errors.
///
/// Display strings intentionally exclude profile ids, PIDs, paths, signing
/// identities, and selector values so they are safe for ordinary diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ProfileSelectorError {
    #[error("PROFILE_SELECTOR_DUPLICATE_ID: immutable profile ids are not unique")]
    DuplicateProfileId,
    #[error("PROFILE_SELECTOR_PROFILE_LIMIT: immutable snapshot has too many profiles")]
    ProfileLimit,
    #[error("PROFILE_SELECTOR_BINDING_LIMIT: immutable snapshot has too many selectors")]
    BindingLimit,
    #[error("PROFILE_SELECTOR_INVALID_PROFILE: immutable profile selection binding is invalid")]
    InvalidProfile,
    #[error("PROFILE_SELECTOR_CONFLICT: immutable profile selection bindings are ambiguous")]
    ConflictingProfiles,
    #[error("PROFILE_SELECTOR_NO_ENABLED_PROFILES: immutable snapshot has no enabled profile")]
    NoEnabledProfiles,
    #[error("PROFILE_SELECTOR_RUNTIME_IDENTITY_INVALID: runtime identity is incomplete")]
    InvalidRuntimeIdentity,
    #[error("PROFILE_SELECTOR_APPLICATION_IDENTITY_INVALID: application identity is invalid")]
    InvalidApplicationIdentity,
    #[error("PROFILE_SELECTOR_QUEUE_BINDING_INVALID: trusted queue profile id is invalid")]
    InvalidTrustedQueueBinding,
    #[error("PROFILE_SELECTOR_QUEUE_PROFILE_UNKNOWN: trusted queue is not in the active snapshot")]
    UnknownTrustedQueueProfile,
    #[error("PROFILE_SELECTOR_QUEUE_PROFILE_DISABLED: trusted queue targets a disabled profile")]
    DisabledTrustedQueueProfile,
    #[error("PROFILE_SELECTOR_CAPTURE_INTENT_INVALID: capture intent and binding are inconsistent")]
    InvalidCaptureIntent,
    #[error(
        "PROFILE_SELECTOR_REQUIRED_EVIDENCE_MISSING: capture intent requires identity evidence"
    )]
    RequiredEvidenceMissing,
    #[error(
        "PROFILE_SELECTOR_CHILD_INHERITANCE_DENIED: profile does not permit trusted child inheritance"
    )]
    ChildInheritanceDenied,
    #[error("PROFILE_SELECTOR_NO_MATCH: no immutable profile matches this flow")]
    NoMatchingProfile,
}

impl ProfileSelectorError {
    /// Stable machine-readable error code without any user identity material.
    pub const fn code(self) -> &'static str {
        match self {
            Self::DuplicateProfileId => "PROFILE_SELECTOR_DUPLICATE_ID",
            Self::ProfileLimit => "PROFILE_SELECTOR_PROFILE_LIMIT",
            Self::BindingLimit => "PROFILE_SELECTOR_BINDING_LIMIT",
            Self::InvalidProfile => "PROFILE_SELECTOR_INVALID_PROFILE",
            Self::ConflictingProfiles => "PROFILE_SELECTOR_CONFLICT",
            Self::NoEnabledProfiles => "PROFILE_SELECTOR_NO_ENABLED_PROFILES",
            Self::InvalidRuntimeIdentity => "PROFILE_SELECTOR_RUNTIME_IDENTITY_INVALID",
            Self::InvalidApplicationIdentity => "PROFILE_SELECTOR_APPLICATION_IDENTITY_INVALID",
            Self::InvalidTrustedQueueBinding => "PROFILE_SELECTOR_QUEUE_BINDING_INVALID",
            Self::UnknownTrustedQueueProfile => "PROFILE_SELECTOR_QUEUE_PROFILE_UNKNOWN",
            Self::DisabledTrustedQueueProfile => "PROFILE_SELECTOR_QUEUE_PROFILE_DISABLED",
            Self::InvalidCaptureIntent => "PROFILE_SELECTOR_CAPTURE_INTENT_INVALID",
            Self::RequiredEvidenceMissing => "PROFILE_SELECTOR_REQUIRED_EVIDENCE_MISSING",
            Self::ChildInheritanceDenied => "PROFILE_SELECTOR_CHILD_INHERITANCE_DENIED",
            Self::NoMatchingProfile => "PROFILE_SELECTOR_NO_MATCH",
        }
    }
}

/// Read-only selector built from one frozen configuration snapshot.
#[derive(Clone)]
pub struct ProfileSelector {
    profiles_by_id: HashMap<String, Arc<RoutingProfileDraft>>,
    specific_profiles: Vec<Arc<RoutingProfileDraft>>,
    global_profile: Option<Arc<RoutingProfileDraft>>,
}

impl ProfileSelector {
    /// Clone saved profiles into an immutable selector snapshot.
    pub fn from_profiles(profiles: &[RoutingProfileDraft]) -> Result<Self, ProfileSelectorError> {
        Self::from_immutable_profiles(profiles.iter().cloned().map(Arc::new))
    }

    /// Build from profiles already owned by an immutable configuration
    /// snapshot. Disabled profiles are retained only so stale trusted-queue
    /// bindings can be distinguished from unknown ids; they are never selected.
    pub fn from_immutable_profiles(
        profiles: impl IntoIterator<Item = Arc<RoutingProfileDraft>>,
    ) -> Result<Self, ProfileSelectorError> {
        let mut profiles_by_id = HashMap::new();
        let mut all_profiles = Vec::new();
        let mut binding_count = 0_usize;

        for profile in profiles {
            if all_profiles.len() >= MAX_PROFILE_SELECTOR_PROFILES {
                return Err(ProfileSelectorError::ProfileLimit);
            }
            binding_count = binding_count
                .checked_add(profile.app_selectors.len())
                .and_then(|count| count.checked_add(profile.runtime_processes.len()))
                .ok_or(ProfileSelectorError::BindingLimit)?;
            if binding_count > MAX_PROFILE_SELECTOR_BINDINGS {
                return Err(ProfileSelectorError::BindingLimit);
            }
            if profiles_by_id.contains_key(&profile.id) {
                return Err(ProfileSelectorError::DuplicateProfileId);
            }
            if !profile_binding_is_valid(&profile) {
                return Err(ProfileSelectorError::InvalidProfile);
            }
            profiles_by_id.insert(profile.id.clone(), profile.clone());
            all_profiles.push(profile);
        }

        let enabled = all_profiles
            .iter()
            .filter(|profile| profile.enabled)
            .map(|profile| profile.as_ref().clone())
            .collect::<Vec<_>>();
        if enabled.is_empty() {
            return Err(ProfileSelectorError::NoEnabledProfiles);
        }
        if !detect_profile_conflicts(&enabled).is_empty() {
            return Err(ProfileSelectorError::ConflictingProfiles);
        }

        let mut specific_profiles = all_profiles
            .iter()
            .filter(|profile| {
                profile.enabled
                    && matches!(
                        profile.scope,
                        ProfileScope::Applications | ProfileScope::RuntimeProcesses
                    )
            })
            .cloned()
            .collect::<Vec<_>>();
        specific_profiles.sort_by(|left, right| {
            (left.priority, scope_rank(left.scope), left.id.as_str()).cmp(&(
                right.priority,
                scope_rank(right.scope),
                right.id.as_str(),
            ))
        });

        let global_profile = all_profiles
            .iter()
            .find(|profile| profile.enabled && profile.scope == ProfileScope::Global)
            .cloned();

        Ok(Self {
            profiles_by_id,
            specific_profiles,
            global_profile,
        })
    }

    /// Choose one profile. Specific runtime/application matches always precede
    /// the global fallback. Among specific matches, lower numeric priority wins;
    /// runtime wins the same-priority cross-scope tie, matching `test_target`.
    pub fn select(
        &self,
        input: &ProfileSelectionInput<'_>,
    ) -> Result<ProfileSelection, ProfileSelectorError> {
        validate_attributed_input(input)?;

        match (input.binding, input.intent) {
            (
                ProfileSelectionBinding::TrustedQueue {
                    profile_id: bound_profile,
                },
                ProfileSelectionIntent::TrustedProfile {
                    profile_id: intended_profile,
                    inherited_child,
                },
            ) if bound_profile == intended_profile => {
                return self.select_trusted_queue(bound_profile, inherited_child);
            }
            (ProfileSelectionBinding::TrustedQueue { .. }, _)
            | (
                ProfileSelectionBinding::Attributed,
                ProfileSelectionIntent::TrustedProfile { .. },
            ) => return Err(ProfileSelectorError::InvalidCaptureIntent),
            (ProfileSelectionBinding::Attributed, _) => {}
        }

        validate_required_evidence(input)?;

        for profile in &self.specific_profiles {
            let source = match profile.scope {
                ProfileScope::RuntimeProcesses
                    if intent_accepts_runtime(input.intent)
                        && input.runtime_process.is_some_and(|identity| {
                            profile.runtime_processes.iter().any(|selector| {
                                selector.pid == identity.pid
                                    && selector.process_start_time == identity.process_start_time
                            })
                        }) =>
                {
                    Some(ProfileSelectionSource::RuntimeProcess)
                }
                ProfileScope::Applications
                    if intent_accepts_application(input.intent)
                        && input.application.is_some_and(|identity| {
                            profile.app_selectors.iter().any(|selector| {
                                selector.matches(Some(identity.kind), identity.value)
                            })
                        }) =>
                {
                    Some(ProfileSelectionSource::Application)
                }
                _ => None,
            };
            if let Some(source) = source {
                return Ok(ProfileSelection {
                    profile: profile.clone(),
                    source,
                });
            }
        }

        if input.intent.global_fallback_policy() == GlobalFallbackPolicy::Deny {
            return Err(ProfileSelectorError::NoMatchingProfile);
        }

        self.global_profile
            .as_ref()
            .cloned()
            .map(|profile| ProfileSelection {
                profile,
                source: ProfileSelectionSource::GlobalFallback,
            })
            .ok_or(ProfileSelectorError::NoMatchingProfile)
    }

    fn select_trusted_queue(
        &self,
        profile_id: &str,
        inherited_child: bool,
    ) -> Result<ProfileSelection, ProfileSelectorError> {
        if !safe_profile_id(profile_id) {
            return Err(ProfileSelectorError::InvalidTrustedQueueBinding);
        }
        let profile = self
            .profiles_by_id
            .get(profile_id)
            .ok_or(ProfileSelectorError::UnknownTrustedQueueProfile)?;
        if !profile.enabled {
            return Err(ProfileSelectorError::DisabledTrustedQueueProfile);
        }
        // Child inheritance is deliberately accepted only on an authenticated
        // queue for a specific profile whose frozen snapshot enables it. There
        // is no ancestry walk or PID-only approximation in the shared selector.
        if inherited_child && (!profile.include_children || profile.scope == ProfileScope::Global) {
            return Err(ProfileSelectorError::ChildInheritanceDenied);
        }
        Ok(ProfileSelection {
            profile: profile.clone(),
            source: ProfileSelectionSource::TrustedQueue,
        })
    }
}

impl fmt::Debug for ProfileSelector {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProfileSelector")
            .field("profile_count", &self.profiles_by_id.len())
            .field("specific_profile_count", &self.specific_profiles.len())
            .field("has_global_profile", &self.global_profile.is_some())
            .finish()
    }
}

fn profile_binding_is_valid(profile: &RoutingProfileDraft) -> bool {
    validate_profile_draft(profile).is_empty()
        && profile
            .app_selectors
            .iter()
            .all(|selector| !selector.value.contains('\0'))
}

fn validate_attributed_input(
    input: &ProfileSelectionInput<'_>,
) -> Result<(), ProfileSelectorError> {
    if input
        .runtime_process
        .is_some_and(|identity| identity.pid == 0 || identity.process_start_time == 0)
    {
        return Err(ProfileSelectorError::InvalidRuntimeIdentity);
    }
    if input.application.is_some_and(|identity| {
        identity.value.trim().is_empty()
            || identity.value.len() > 4096
            || identity.value.contains('\0')
    }) {
        return Err(ProfileSelectorError::InvalidApplicationIdentity);
    }
    Ok(())
}

fn validate_required_evidence(
    input: &ProfileSelectionInput<'_>,
) -> Result<(), ProfileSelectorError> {
    let present = match input.intent {
        ProfileSelectionIntent::AllowGlobalFallback => true,
        ProfileSelectionIntent::RequireApplication => input.application.is_some(),
        ProfileSelectionIntent::RequireRuntimeProcess => input.runtime_process.is_some(),
        ProfileSelectionIntent::RequireAnySpecific => {
            input.application.is_some() || input.runtime_process.is_some()
        }
        ProfileSelectionIntent::TrustedProfile { .. } => {
            return Err(ProfileSelectorError::InvalidCaptureIntent);
        }
    };
    if present {
        Ok(())
    } else {
        Err(ProfileSelectorError::RequiredEvidenceMissing)
    }
}

const fn intent_accepts_runtime(intent: ProfileSelectionIntent<'_>) -> bool {
    matches!(
        intent,
        ProfileSelectionIntent::AllowGlobalFallback
            | ProfileSelectionIntent::RequireRuntimeProcess
            | ProfileSelectionIntent::RequireAnySpecific
    )
}

const fn intent_accepts_application(intent: ProfileSelectionIntent<'_>) -> bool {
    matches!(
        intent,
        ProfileSelectionIntent::AllowGlobalFallback
            | ProfileSelectionIntent::RequireApplication
            | ProfileSelectionIntent::RequireAnySpecific
    )
}

fn safe_profile_id(profile_id: &str) -> bool {
    !profile_id.is_empty()
        && profile_id.len() <= 128
        && profile_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

const fn scope_rank(scope: ProfileScope) -> u8 {
    match scope {
        ProfileScope::RuntimeProcesses => 0,
        ProfileScope::Applications => 1,
        ProfileScope::Global => 2,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sockscap::types::{AppSelector, RuntimeProcessSelector};

    fn global(id: &str, priority: u32) -> RoutingProfileDraft {
        RoutingProfileDraft {
            id: id.into(),
            name: format!("Profile {id}"),
            enabled: true,
            priority,
            scope: ProfileScope::Global,
            ..Default::default()
        }
    }

    fn application(id: &str, priority: u32, path: &str) -> RoutingProfileDraft {
        RoutingProfileDraft {
            id: id.into(),
            name: format!("Profile {id}"),
            enabled: true,
            priority,
            scope: ProfileScope::Applications,
            app_selectors: vec![AppSelector::executable_path(path)],
            ..Default::default()
        }
    }

    fn runtime(id: &str, priority: u32, pid: u32, start: u64) -> RoutingProfileDraft {
        RoutingProfileDraft {
            id: id.into(),
            name: format!("Profile {id}"),
            enabled: true,
            priority,
            scope: ProfileScope::RuntimeProcesses,
            runtime_processes: vec![RuntimeProcessSelector {
                pid,
                process_start_time: start,
            }],
            ..Default::default()
        }
    }

    #[test]
    fn specific_match_precedes_global_regardless_of_priority() {
        let profiles = vec![
            global("global", 0),
            application("curl", 500, "/usr/bin/curl"),
        ];
        let selector = ProfileSelector::from_profiles(&profiles).unwrap();
        let selected = selector
            .select(&ProfileSelectionInput {
                application: Some(ApplicationIdentity {
                    kind: AppSelectorKind::ExecutablePath,
                    value: "/usr/bin/curl",
                }),
                ..Default::default()
            })
            .unwrap();

        assert_eq!(selected.profile_id(), "curl");
        assert_eq!(selected.source(), ProfileSelectionSource::Application);
    }

    #[test]
    fn lower_numeric_priority_wins_between_specific_matches() {
        let profiles = vec![
            application("later", 50, "/usr/bin/curl"),
            application("first", 10, "/usr/bin/curl"),
        ];
        let selector = ProfileSelector::from_profiles(&profiles).unwrap();
        let selected = selector
            .select(&ProfileSelectionInput {
                application: Some(ApplicationIdentity {
                    kind: AppSelectorKind::ExecutablePath,
                    value: "/usr/bin/curl",
                }),
                ..Default::default()
            })
            .unwrap();

        assert_eq!(selected.profile_id(), "first");
    }

    #[test]
    fn runtime_requires_the_exact_pid_start_token_pair() {
        let profiles = vec![global("global", 0), runtime("runtime", 10, 441, 9001)];
        let selector = ProfileSelector::from_profiles(&profiles).unwrap();

        let exact = selector
            .select(&ProfileSelectionInput {
                runtime_process: Some(RuntimeProcessIdentity {
                    pid: 441,
                    process_start_time: 9001,
                }),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(exact.profile_id(), "runtime");
        assert_eq!(exact.source(), ProfileSelectionSource::RuntimeProcess);

        let reused_pid = selector.select(&ProfileSelectionInput {
            intent: ProfileSelectionIntent::RequireRuntimeProcess,
            runtime_process: Some(RuntimeProcessIdentity {
                pid: 441,
                process_start_time: 9002,
            }),
            ..Default::default()
        });
        assert_eq!(reused_pid, Err(ProfileSelectorError::NoMatchingProfile));

        let legitimate_global = selector
            .select(&ProfileSelectionInput {
                intent: ProfileSelectionIntent::AllowGlobalFallback,
                runtime_process: Some(RuntimeProcessIdentity {
                    pid: 441,
                    process_start_time: 9002,
                }),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(legitimate_global.profile_id(), "global");
        assert_eq!(
            legitimate_global.source(),
            ProfileSelectionSource::GlobalFallback
        );

        let invalid = selector.select(&ProfileSelectionInput {
            runtime_process: Some(RuntimeProcessIdentity {
                pid: 441,
                process_start_time: 0,
            }),
            ..Default::default()
        });
        assert_eq!(invalid, Err(ProfileSelectorError::InvalidRuntimeIdentity));
    }

    #[test]
    fn unknown_trusted_queue_never_falls_back() {
        let profiles = vec![global("global", 0)];
        let selector = ProfileSelector::from_profiles(&profiles).unwrap();
        let result = selector.select(&ProfileSelectionInput {
            binding: ProfileSelectionBinding::TrustedQueue {
                profile_id: "stale_profile",
            },
            intent: ProfileSelectionIntent::TrustedProfile {
                profile_id: "stale_profile",
                inherited_child: false,
            },
            ..Default::default()
        });

        assert_eq!(
            result,
            Err(ProfileSelectorError::UnknownTrustedQueueProfile)
        );
        assert!(!result.unwrap_err().to_string().contains("stale_profile"));
    }

    #[test]
    fn disabled_trusted_queue_is_rejected() {
        let mut disabled = application("disabled", 10, "/private/app");
        disabled.enabled = false;
        let profiles = vec![global("global", 0), disabled];
        let selector = ProfileSelector::from_profiles(&profiles).unwrap();

        assert_eq!(
            selector.select(&ProfileSelectionInput {
                binding: ProfileSelectionBinding::TrustedQueue {
                    profile_id: "disabled",
                },
                intent: ProfileSelectionIntent::TrustedProfile {
                    profile_id: "disabled",
                    inherited_child: false,
                },
                ..Default::default()
            }),
            Err(ProfileSelectorError::DisabledTrustedQueueProfile)
        );
    }

    #[test]
    fn duplicate_profile_ids_are_rejected_before_indexing() {
        let profiles = vec![global("same", 0), application("same", 10, "/private/app")];
        assert!(matches!(
            ProfileSelector::from_profiles(&profiles),
            Err(ProfileSelectorError::DuplicateProfileId)
        ));
    }

    #[test]
    fn global_fallback_requires_an_explicit_allow_policy() {
        let profiles = vec![global("global", 0)];
        let selector = ProfileSelector::from_profiles(&profiles).unwrap();

        assert_eq!(
            selector.select(&ProfileSelectionInput::default()),
            Err(ProfileSelectorError::RequiredEvidenceMissing)
        );
        let selected = selector
            .select(&ProfileSelectionInput {
                intent: ProfileSelectionIntent::AllowGlobalFallback,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(selected.profile_id(), "global");
        assert_eq!(selected.source(), ProfileSelectionSource::GlobalFallback);
    }

    #[test]
    fn required_identity_scope_cannot_match_another_scope_or_global() {
        let profiles = vec![
            global("global", 0),
            application("app", 10, "/usr/bin/curl"),
            runtime("runtime", 10, 441, 9001),
        ];
        let selector = ProfileSelector::from_profiles(&profiles).unwrap();
        let input = ProfileSelectionInput {
            intent: ProfileSelectionIntent::RequireApplication,
            runtime_process: Some(RuntimeProcessIdentity {
                pid: 441,
                process_start_time: 9001,
            }),
            application: Some(ApplicationIdentity {
                kind: AppSelectorKind::ExecutablePath,
                value: "/not/curl",
            }),
            ..Default::default()
        };
        assert_eq!(
            selector.select(&input),
            Err(ProfileSelectorError::NoMatchingProfile)
        );

        let missing_application = ProfileSelectionInput {
            intent: ProfileSelectionIntent::RequireApplication,
            runtime_process: input.runtime_process,
            ..Default::default()
        };
        assert_eq!(
            selector.select(&missing_application),
            Err(ProfileSelectorError::RequiredEvidenceMissing)
        );
    }

    #[test]
    fn trusted_binding_and_intent_must_match() {
        let profiles = vec![application("app", 10, "/usr/bin/curl")];
        let selector = ProfileSelector::from_profiles(&profiles).unwrap();
        assert_eq!(
            selector.select(&ProfileSelectionInput {
                binding: ProfileSelectionBinding::TrustedQueue { profile_id: "app" },
                intent: ProfileSelectionIntent::TrustedProfile {
                    profile_id: "other",
                    inherited_child: false,
                },
                ..Default::default()
            }),
            Err(ProfileSelectorError::InvalidCaptureIntent)
        );
        assert_eq!(
            selector.select(&ProfileSelectionInput {
                binding: ProfileSelectionBinding::Attributed,
                intent: ProfileSelectionIntent::TrustedProfile {
                    profile_id: "app",
                    inherited_child: false,
                },
                ..Default::default()
            }),
            Err(ProfileSelectorError::InvalidCaptureIntent)
        );
    }

    #[test]
    fn child_inheritance_is_trusted_queue_only_and_snapshot_gated() {
        let mut denied = application("denied", 10, "/usr/bin/curl");
        denied.include_children = false;
        let allowed = application("allowed", 20, "/usr/bin/wget");
        let profiles = vec![denied, allowed];
        let selector = ProfileSelector::from_profiles(&profiles).unwrap();

        assert_eq!(
            selector.select(&ProfileSelectionInput {
                binding: ProfileSelectionBinding::TrustedQueue {
                    profile_id: "denied",
                },
                intent: ProfileSelectionIntent::TrustedProfile {
                    profile_id: "denied",
                    inherited_child: true,
                },
                ..Default::default()
            }),
            Err(ProfileSelectorError::ChildInheritanceDenied)
        );

        let selected = selector
            .select(&ProfileSelectionInput {
                binding: ProfileSelectionBinding::TrustedQueue {
                    profile_id: "allowed",
                },
                intent: ProfileSelectionIntent::TrustedProfile {
                    profile_id: "allowed",
                    inherited_child: true,
                },
                ..Default::default()
            })
            .unwrap();
        assert_eq!(selected.profile_id(), "allowed");
        assert_eq!(selected.source(), ProfileSelectionSource::TrustedQueue);
    }

    #[test]
    fn immutable_snapshot_profile_count_is_bounded_before_conflict_scan() {
        let profiles = (0..=MAX_PROFILE_SELECTOR_PROFILES)
            .map(|index| global(&format!("profile-{index}"), index as u32))
            .collect::<Vec<_>>();
        assert!(matches!(
            ProfileSelector::from_profiles(&profiles),
            Err(ProfileSelectorError::ProfileLimit)
        ));
    }
}
