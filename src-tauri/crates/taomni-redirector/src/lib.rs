//! Shared transport and pinned identity for the macOS Redirector integration.

pub mod bridge_protocol;
pub mod ipc;

#[cfg(target_os = "macos")]
pub mod identity;

pub const REDIRECTOR_VERSION: &str = "0.12.11";
pub const REDIRECTOR_TEAM_ID: &str = "S8XHQB96PW";
pub const REDIRECTOR_EXTENSION_BUNDLE_ID: &str = "org.mitmproxy.macos-redirector.network-extension";
pub const REDIRECTOR_EXTENSION_EXECUTABLE_SHA256: &str =
    "0785d00082db59543c093fe63581d31060f5fdc9677dbf2796bf6ac473f6087a";

pub fn inert_actions() -> Vec<String> {
    vec![format!(
        "/__taomni_no_process__/{}/",
        uuid::Uuid::new_v4().simple()
    )]
}
