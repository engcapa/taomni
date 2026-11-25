//! Shared manifest/catalog metadata, independent of the desktop application.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PluginKind {
    RemoteClient,
    LocalServer,
    Collaboration,
    Media,
    Auth,
    AiLocal,
    Mobile,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_and_catalog_categories_keep_the_v1_wire_values() {
        for (kind, name) in [
            (PluginKind::RemoteClient, "remote-client"),
            (PluginKind::LocalServer, "local-server"),
            (PluginKind::Collaboration, "collaboration"),
            (PluginKind::Media, "media"),
            (PluginKind::Auth, "auth"),
            (PluginKind::AiLocal, "ai-local"),
            (PluginKind::Mobile, "mobile"),
        ] {
            let wire = serde_json::json!(name);
            assert_eq!(serde_json::to_value(&kind).unwrap(), wire);
            assert_eq!(serde_json::from_value::<PluginKind>(wire).unwrap(), kind);
        }
        for name in ["lanchat", "nettools", "third-party", "RemoteClient", ""] {
            assert!(serde_json::from_value::<PluginKind>(serde_json::json!(name)).is_err());
        }
    }
}
