#[cfg(target_os = "macos")]
pub(super) const EXPERIMENTAL_AVC420_ENV: &str = "TAOMNI_RDP_EXPERIMENTAL_AVC420";
#[cfg(target_os = "macos")]
pub(super) const EXPERIMENTAL_CLIENT_SIZE_ENV: &str = "TAOMNI_RDP_EXPERIMENTAL_CLIENT_SIZE";

#[cfg(target_os = "macos")]
pub(super) fn experimental_feature_enabled(name: &str) -> bool {
    std::env::var(name)
        .ok()
        .as_deref()
        .is_some_and(experimental_feature_value)
}

#[cfg(any(target_os = "macos", test))]
pub(super) fn experimental_feature_value(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}
