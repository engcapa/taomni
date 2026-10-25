//! Range planning only; archive formats and scope flags remain compatible.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackupCustomOptions {
    #[serde(default)]
    pub include_sessions: bool,
    #[serde(default)]
    pub include_notes: bool,
    #[serde(default)]
    pub include_vault: bool,
    #[serde(default)]
    pub include_lanchat: bool,
    #[serde(default)]
    pub include_configs: bool,
    #[serde(default)]
    pub include_mail: bool,
    #[serde(default)]
    pub include_local_history: bool,
    #[serde(default)]
    pub include_mfa: bool,
}

/// What a backup scope stages. MFA secrets are sealed with a data key held in
/// the vault, so including `mfa.db` always includes `vault.db` as well.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BackupScopeFlags {
    pub sessions: bool,
    pub notes: bool,
    pub vault: bool,
    pub lanchat: bool,
    pub configs: bool,
    pub mail: bool,
    pub local_history: bool,
    pub mfa: bool,
}

pub fn resolve_scope_flags(scope: &str, custom: Option<BackupCustomOptions>) -> BackupScopeFlags {
    let mail_override = custom.as_ref().map(|opts| opts.include_mail);
    let core = BackupScopeFlags {
        sessions: true,
        notes: true,
        vault: true,
        lanchat: false,
        configs: true,
        mail: false,
        local_history: false,
        mfa: true,
    };
    let mut flags = match scope {
        "full" => BackupScopeFlags {
            lanchat: true,
            mail: true,
            ..core
        },
        "custom" => match custom {
            Some(opts) => BackupScopeFlags {
                sessions: opts.include_sessions,
                notes: opts.include_notes,
                vault: opts.include_vault,
                lanchat: opts.include_lanchat,
                configs: opts.include_configs,
                mail: opts.include_mail,
                local_history: opts.include_local_history,
                mfa: opts.include_mfa,
            },
            None => core,
        },
        _ => core,
    };
    if scope != "custom" {
        if let Some(mail) = mail_override {
            flags.mail = mail;
        }
    }
    if flags.mfa {
        flags.vault = true;
    }
    flags
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackupRange {
    pub scope: String,
    pub custom_options: Option<BackupCustomOptions>,
}

pub fn global(policy: &super::policy::BackupPolicy) -> BackupRange {
    BackupRange {
        scope: policy.default_scope.clone(),
        custom_options: if policy.default_scope == "custom" {
            policy.default_custom_options.clone()
        } else {
            policy.include_mail.map(|include_mail| BackupCustomOptions {
                include_mail,
                ..Default::default()
            })
        },
    }
}

impl BackupRange {
    pub fn validate(&self) -> Result<(), String> {
        if !["core", "full", "custom"].contains(&self.scope.as_str()) {
            return Err("Invalid backup scope".into());
        }
        Ok(())
    }

    pub fn source(&self) -> super::model::SourceSpec {
        super::model::SourceSpec {
            scope: self.scope.clone(),
            custom_options: self.custom_options.clone(),
            ..Default::default()
        }
    }
}

pub fn scheduled(
    policy: &super::policy::BackupPolicy,
    target: &super::model::BackupTarget,
) -> super::model::SourceSpec {
    if target.range_mode == "inherit" {
        global(policy).source()
    } else {
        target.source.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_full_and_explicit_mail_exclusion_keep_their_contents() {
        let mut policy = super::super::policy::BackupPolicy {
            default_scope: "full".into(),
            ..Default::default()
        };
        let full = global(&policy);
        let flags = resolve_scope_flags(&full.scope, full.custom_options);
        assert!(flags.mail && flags.lanchat && flags.vault && flags.mfa);
        assert!(!flags.local_history);
        policy.include_mail = Some(false);
        let range = global(&policy);
        assert!(!resolve_scope_flags(&range.scope, range.custom_options).mail);
    }

    #[test]
    fn scheduled_override_and_inheritance_do_not_change_manual_global_range() {
        let policy = super::super::policy::BackupPolicy {
            default_scope: "full".into(),
            ..Default::default()
        };
        let mut target: super::super::model::BackupTarget = serde_json::from_value(
            serde_json::json!({"id":"t","name":"old","kind":"feishu","enabled":false,
                "rootToken":"","source":{"kind":"taomni","schemaVersion":1,"scope":"core","customOptions":null}}),
        ).unwrap();
        assert_eq!(target.range_mode, "custom");
        assert_eq!(scheduled(&policy, &target).scope, "core");
        assert_eq!(global(&policy).source().scope, "full");
        target.range_mode = "inherit".into();
        let frozen = scheduled(&policy, &target);
        assert_eq!(frozen.scope, "full");
        let changed = super::super::policy::BackupPolicy::default();
        assert_eq!(scheduled(&changed, &target).scope, "core");
        assert_eq!(frozen.scope, "full");
    }
}
