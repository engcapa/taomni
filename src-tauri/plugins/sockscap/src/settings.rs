//! The host has one profile writer lease. All settings mutations pass through
//! its SDK operation, including the first import from the legacy desktop.
use std::{io, path::Path};

use serde::{Serialize, de::DeserializeOwned};
use taomni_module_settings::SettingsFile;
use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_plugin_sdk::{Operation, SnapshotExport, SnapshotProvider};
use taomni_plugin_stream::{length_prefixed, routed_tcp::Endpoint};
use taomni_sockscap_api::{
    CONFIG_PATH, RULES_PATH, RulesRequest, SettingsRequest, SocksCapConfig,
    gfwlist_rules::RuleCache,
    policy::{SavedTargetReply, SavedTargetRequest, TargetRuleProbe},
};
use tokio::runtime::Runtime;

pub(super) struct Settings {
    file: SettingsFile,
    rules: SettingsFile,
}

impl Settings {
    pub(super) fn new(profile: &Path) -> Self {
        Self {
            file: SettingsFile::with_limit(profile, CONFIG_PATH, u64::MAX),
            rules: SettingsFile::with_limit(profile, RULES_PATH, u64::MAX),
        }
    }

    fn apply(
        &self,
        request: SettingsRequest,
        before_publish: impl FnOnce() -> io::Result<()>,
    ) -> Result<Option<SocksCapConfig>, String> {
        let (mut config, return_config) = match request {
            SettingsRequest::Read => return self.file.load().map_err(|e| e.to_string()),
            SettingsRequest::Adopt(seed) => {
                if let Some(current) = self.file.load().map_err(|e| e.to_string())? {
                    return Ok(Some(current));
                }
                (seed, true)
            }
            SettingsRequest::Save(config) => {
                config.validate()?;
                (config, false)
            }
        };
        config.normalize();
        self.file
            .save_checked(&config, before_publish)
            .map_err(|e| e.to_string())?;
        Ok(return_config.then_some(*config))
    }

    pub(super) fn exchange(
        &self,
        io: &Runtime,
        operation: &Operation,
        endpoint: Endpoint,
    ) -> Result<serde_json::Value, RpcError> {
        transfer(io, operation, endpoint, |request| {
            self.apply(request, || check_publish(operation))
        })
    }

    fn apply_rules(
        &self,
        request: RulesRequest,
        before_publish: impl FnOnce() -> io::Result<()>,
    ) -> Result<Option<RuleCache>, String> {
        let (mut cache, adopted) = match request {
            RulesRequest::Read => return self.rules.load().map_err(|error| error.to_string()),
            RulesRequest::Adopt(seed) => {
                if let Some(current) = self.rules.load().map_err(|error| error.to_string())? {
                    return Ok(Some(current));
                }
                (seed, true)
            }
            RulesRequest::Replace(cache) => (cache, false),
        };
        cache.meta = cache.compile()?.meta;
        self.rules
            .save_checked(&cache, before_publish)
            .map_err(|error| error.to_string())?;
        Ok(adopted.then_some(cache))
    }

    pub(super) fn exchange_rules(
        &self,
        io: &Runtime,
        operation: &Operation,
        endpoint: Endpoint,
    ) -> Result<serde_json::Value, RpcError> {
        transfer(io, operation, endpoint, |request| {
            self.apply_rules(request, || check_publish(operation))
        })
    }

    fn test_saved_target(&self, request: SavedTargetRequest) -> Result<SavedTargetReply, String> {
        let config: Option<SocksCapConfig> = self.file.load().map_err(|error| error.to_string())?;
        let cache: Option<RuleCache> = self.rules.load().map_err(|error| error.to_string())?;
        let settings_missing = config.is_none();
        let rules_missing = cache.is_none() && !request.legacy_rules_checked;
        let Some(mut config) = config.filter(|_| !rules_missing) else {
            return Ok(SavedTargetReply::Adopt {
                settings_missing,
                rules_missing,
            });
        };
        config.normalize();
        let rules = cache.as_ref().map(RuleCache::compile).transpose()?;
        let result =
            TargetRuleProbe::for_config(&config, rules.as_ref(), request.host, request.port)
                .evaluate();
        Ok(SavedTargetReply::Evaluated { result })
    }

    pub(super) fn exchange_saved_target(
        &self,
        io: &Runtime,
        operation: &Operation,
        endpoint: Endpoint,
    ) -> Result<serde_json::Value, RpcError> {
        transfer(io, operation, endpoint, |request| {
            self.test_saved_target(request)
        })
    }
}

fn check_publish(operation: &Operation) -> io::Result<()> {
    operation
        .check_current()
        .map_err(|error| io::Error::other(error.message))
}

fn transfer<Request: DeserializeOwned, Reply: Serialize>(
    io: &Runtime,
    operation: &Operation,
    endpoint: Endpoint,
    apply: impl FnOnce(Request) -> Result<Reply, String>,
) -> Result<serde_json::Value, RpcError> {
    let (mut peer, _) = io
        .block_on(operation.while_current(endpoint.connect()))?
        .map_err(failed)?;
    let bytes = io
        .block_on(operation.while_current(length_prefixed::read(&mut peer)))?
        .map_err(failed)?;
    let request = serde_json::from_slice(&bytes)
        .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
    operation.check_current()?;
    let reply = apply(request).map_err(failed)?;
    let bytes = serde_json::to_vec(&reply).map_err(failed)?;
    io.block_on(operation.while_current(length_prefixed::write(&mut peer, &bytes)))?
        .map_err(failed)?;
    Ok(serde_json::Value::Null)
}

fn failed(error: impl std::fmt::Display) -> RpcError {
    RpcError::new(ErrorCode::InvalidState, error.to_string())
}

impl SnapshotProvider for Settings {
    fn freeze(&self, operation: &Operation) -> Result<(), RpcError> {
        operation.check_current()
    }

    fn export(&self, output: &mut SnapshotExport, operation: &Operation) -> Result<(), RpcError> {
        operation.check_current()?;
        if let Some(file) = self.file.open().map_err(failed)? {
            output.file("config.json", file)?;
        }
        if let Some(file) = self.rules.open().map_err(failed)? {
            output.file("rules.json", file)?;
        }
        Ok(())
    }

    fn resume(&self) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn legacy(host: &str) -> Box<SocksCapConfig> {
        Box::new(
            serde_json::from_value(serde_json::json!({
                "upstream": {"host": host, "port": 19391, "kind": "socks5"}
            }))
            .unwrap(),
        )
    }

    #[test]
    fn adopt_once_then_reopen_current_settings_even_if_an_old_import_is_retried() {
        let profile = tempfile::tempdir().unwrap();
        let settings = Settings::new(profile.path());
        assert!(
            settings
                .apply(SettingsRequest::Read, || Ok(()))
                .unwrap()
                .is_none()
        );
        let mut config = settings
            .apply(SettingsRequest::Adopt(legacy("old.example")), || Ok(()))
            .unwrap()
            .unwrap();
        assert_eq!(config.profiles[0].upstream.host, "old.example");
        config.profiles[0].upstream.host = "current.example".into();
        settings
            .apply(SettingsRequest::Save(Box::new(config)), || Ok(()))
            .unwrap();
        let reopened = Settings::new(profile.path());
        for request in [
            SettingsRequest::Adopt(legacy("stale.example")),
            SettingsRequest::Read,
        ] {
            let current = reopened
                .apply(request, || panic!("must not replace settings"))
                .unwrap()
                .unwrap();
            assert_eq!(current.upstream.host, "current.example");
            assert_eq!(current.profiles[0].upstream.host, "current.example");
        }
    }

    #[test]
    fn cancelled_and_invalid_edits_preserve_the_published_configuration() {
        let profile = tempfile::tempdir().unwrap();
        let settings = Settings::new(profile.path());
        let mut current = settings
            .apply(SettingsRequest::Adopt(legacy("old.example")), || Ok(()))
            .unwrap()
            .unwrap();
        let file = profile.path().join(CONFIG_PATH);
        let original = fs::read(&file).unwrap();
        current.profiles[0].upstream.host = "interrupted.example".into();
        assert!(
            settings
                .apply(SettingsRequest::Save(Box::new(current.clone())), || Err(
                    io::Error::new(io::ErrorKind::Interrupted, "request cancelled")
                ))
                .is_err()
        );
        current.profiles[0].upstream.host.clear();
        assert!(
            settings
                .apply(SettingsRequest::Save(Box::new(current)), || Ok(()))
                .is_err()
        );
        assert_eq!(fs::read(&file).unwrap(), original);
        assert_eq!(fs::read_dir(file.parent().unwrap()).unwrap().count(), 1);
        fs::write(&file, b"invalid JSON").unwrap();
        assert!(
            settings
                .apply(SettingsRequest::Adopt(legacy("stale.example")), || Ok(()))
                .is_err()
        );
        assert_eq!(fs::read(file).unwrap(), b"invalid JSON");
    }

    #[test]
    fn adopted_rules_keep_their_metadata_and_cancelled_updates_keep_the_original() {
        let profile = tempfile::tempdir().unwrap();
        let settings = Settings::new(profile.path());
        let cache = |raw: &str| RuleCache {
            raw: raw.into(),
            meta: taomni_sockscap_api::gfwlist_rules::GfwListMeta {
                source: "legacy fixture".into(),
                rule_count: 0,
                skipped: 0,
                last_refresh: Some("fixture date".into()),
                etag: Some("fixture etag".into()),
            },
        };
        let raw = "[AutoProxy 0.2.9]\n||proxied.example.test\n";
        let adopted = settings
            .apply_rules(RulesRequest::Adopt(cache(raw)), || Ok(()))
            .unwrap()
            .unwrap();
        assert_eq!(adopted.meta.rule_count, 1);
        assert_eq!(adopted.meta.last_refresh.as_deref(), Some("fixture date"));
        assert_eq!(adopted.meta.etag.as_deref(), Some("fixture etag"));
        let replacement = "[AutoProxy 0.2.9]\n||replacement.example.test\n";
        assert!(
            settings
                .apply_rules(RulesRequest::Replace(cache(replacement)), || Err(
                    io::Error::other("cancelled")
                ))
                .is_err()
        );
        let retained = Settings::new(profile.path())
            .apply_rules(RulesRequest::Adopt(cache(replacement)), || {
                panic!("already adopted")
            })
            .unwrap()
            .unwrap();
        assert_eq!(retained.raw, raw);
        assert!(matches!(
            retained
                .compile()
                .unwrap()
                .match_host("proxied.example.test"),
            taomni_sockscap_api::gfwlist_rules::RuleMatch::Proxy { .. }
        ));
    }

    #[test]
    fn saved_target_uses_persisted_rules_and_only_requests_adoption_for_missing_files() {
        use taomni_sockscap_api::{Decision, UserRule, UserRuleAction, gfwlist_rules::GfwListMeta};

        let profile = tempfile::tempdir().unwrap();
        let settings = Settings::new(profile.path());
        let test_target = |host: &str, legacy_rules_checked| {
            settings.test_saved_target(SavedTargetRequest {
                host: host.into(),
                port: 443,
                legacy_rules_checked,
            })
        };
        assert!(matches!(
            test_target("persisted.example.test", false).unwrap(),
            SavedTargetReply::Adopt {
                settings_missing: true,
                rules_missing: true
            }
        ));

        let mut config = legacy("upstream.example.test");
        config.user_rules.push(UserRule {
            pattern: "blocked.example.test".into(),
            action: UserRuleAction::Block,
            comment: String::new(),
        });
        settings
            .apply(SettingsRequest::Adopt(config), || Ok(()))
            .unwrap();
        assert!(matches!(
            test_target("persisted.example.test", false).unwrap(),
            SavedTargetReply::Adopt {
                settings_missing: false,
                rules_missing: true
            }
        ));
        assert!(matches!(
            test_target("blocked.example.test", true).unwrap(),
            SavedTargetReply::Evaluated { result }
                if result.decision == Decision::Block
                    && result.matched_rule.as_deref() == Some("blocked.example.test")
        ));

        settings
            .apply_rules(
                RulesRequest::Adopt(RuleCache {
                    raw: "||persisted.example.test\n".into(),
                    meta: GfwListMeta {
                        source: "fixture".into(),
                        rule_count: 0,
                        skipped: 0,
                        last_refresh: None,
                        etag: None,
                    },
                }),
                || Ok(()),
            )
            .unwrap();
        assert!(matches!(
            test_target("persisted.example.test", false).unwrap(),
            SavedTargetReply::Evaluated { result }
                if result.decision == Decision::Proxy
                    && result.matched_rule.as_deref() == Some("||persisted.example.test")
        ));
        assert!(matches!(
            test_target("127.0.0.1", false).unwrap(),
            SavedTargetReply::Evaluated { result } if result.decision == Decision::Direct
        ));

        let rules = profile.path().join(RULES_PATH);
        fs::write(&rules, b"corrupt rules").unwrap();
        assert!(test_target("persisted.example.test", true).is_err());
        assert_eq!(fs::read(rules).unwrap(), b"corrupt rules");
    }
}
