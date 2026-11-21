use portable_pty::CommandBuilder;
#[cfg(target_os = "macos")]
use std::ffi::OsStr;

#[cfg(unix)]
pub(super) fn apply_terminal_environment(cmd: &mut CommandBuilder) {
    cmd.env("TERM", "xterm-256color");

    #[cfg(target_os = "macos")]
    apply_macos_utf8_locale(cmd);
}

#[cfg(target_os = "macos")]
pub(super) fn apply_macos_utf8_locale(cmd: &mut CommandBuilder) {
    let locale = preferred_utf8_locale(cmd).unwrap_or_else(|| "en_US.UTF-8".to_string());

    set_if_not_full_utf8_locale(cmd, "LANG", &locale);
    set_lc_ctype_if_not_utf8(cmd, &locale);
    set_lc_all_if_present_and_not_full_utf8_locale(cmd, &locale);
}

#[cfg(target_os = "macos")]
pub(super) fn preferred_utf8_locale(cmd: &CommandBuilder) -> Option<String> {
    ["LANG", "LC_CTYPE", "LC_ALL"]
        .into_iter()
        .filter_map(|key| cmd.get_env(key))
        .filter_map(OsStr::to_str)
        .map(str::trim)
        .find(|value| locale_is_full_utf8(value))
        .map(str::to_string)
}

#[cfg(target_os = "macos")]
pub(super) fn set_if_not_full_utf8_locale(cmd: &mut CommandBuilder, key: &str, value: &str) {
    if !cmd
        .get_env(key)
        .and_then(OsStr::to_str)
        .map(str::trim)
        .is_some_and(locale_is_full_utf8)
    {
        cmd.env(key, value);
    }
}

#[cfg(target_os = "macos")]
pub(super) fn set_lc_ctype_if_not_utf8(cmd: &mut CommandBuilder, value: &str) {
    if !cmd
        .get_env("LC_CTYPE")
        .and_then(OsStr::to_str)
        .map(str::trim)
        .is_some_and(locale_is_valid_macos_lc_ctype)
    {
        cmd.env("LC_CTYPE", value);
    }
}

#[cfg(target_os = "macos")]
pub(super) fn set_lc_all_if_present_and_not_full_utf8_locale(
    cmd: &mut CommandBuilder,
    value: &str,
) {
    if cmd
        .get_env("LC_ALL")
        .and_then(OsStr::to_str)
        .map(str::trim)
        .is_some_and(|current| !current.is_empty() && !locale_is_full_utf8(current))
    {
        cmd.env("LC_ALL", value);
    }
}

#[cfg(target_os = "macos")]
pub(super) fn locale_is_valid_macos_lc_ctype(value: &str) -> bool {
    normalized_locale(value) == "UTF8" || locale_is_full_utf8(value)
}

#[cfg(target_os = "macos")]
pub(super) fn locale_is_full_utf8(value: &str) -> bool {
    let normalized = normalized_locale(value);
    normalized.contains('.') && normalized.contains("UTF8") && !normalized.starts_with("C.")
}

#[cfg(target_os = "macos")]
pub(super) fn normalized_locale(value: &str) -> String {
    value.to_ascii_uppercase().replace('-', "")
}
