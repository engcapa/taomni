mod command;

mod vmargs;

mod settings;

mod selection;

mod probe;

mod data;

pub(super) use command::is_jdtls_program;

#[cfg(windows)]
pub(super) use command::windows_cmd_line;

#[cfg(windows)]
pub(super) use command::windows_quote_arg;

#[cfg(windows)]
pub(super) use command::resolve_server_program;

#[cfg(windows)]
pub(super) use command::build_jdtls_java_command;

#[cfg(windows)]
pub(super) use command::resolve_jdtls_home;

#[cfg(windows)]
pub(super) use command::find_equinox_launcher;

pub(super) use vmargs::{
    apply_jdtls_vmargs_to_command, configured_java_vmargs_lock, get_configured_java_vmargs,
    jdtls_vmargs, jdtls_vmargs_string, lombok_javaagent_arg, set_configured_java_vmargs,
    split_jvm_args,
};

pub use settings::JavaLanguageSettings;

pub(super) use settings::{
    configured_java_settings_lock, get_configured_java_settings, non_empty_or_null,
    set_configured_java_settings,
};

pub(super) use selection::{
    configured_java_home_lock, get_configured_java_home, java_home_from_binary,
    push_java_candidate, resolve_java_binary_from_user_path, resolve_java_for_jdtls,
    resolve_java_for_jdtls_with_sdk, set_configured_java_home,
};

pub(super) use probe::{
    command_is_jdtls, java_major_version, jdtls_runtime_probe,
    parse_java_major_from_version_output, preset_uses_jdtls,
};

pub(super) use data::{
    ensure_jdtls_data_dir, jdtls_data_dir, jdtls_data_root, prune_stale_jdtls_data_dirs,
};
