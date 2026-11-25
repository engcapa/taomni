//! Compile the actual maintenance service, exporter and Vault read/crypto code.
//! Only the two explicitly selected in-memory unit modules run locally.
#![allow(dead_code)]

#[path = "legacy_key_service/native.rs"]
mod native;
#[path = "legacy_key_service/plugin.rs"]
mod plugin;
#[path = "legacy_key_service/support.rs"]
mod support;
#[path = "legacy_key_service/vault.rs"]
mod vault;
