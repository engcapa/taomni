//! Launch and talk to the elevated SocksCap helper (Windows UAC).

mod model;

mod registry;

mod startup;

mod status;

mod requests;

mod capture_commands;

mod original_destination;

mod client;

pub use model::{CaptureStartArgs, HelperStatus, OrigMapping};

pub use registry::{HelperRegistry, HelperSession};

pub use startup::{ensure_helper, sockscap_helper_start};

pub(crate) use startup::{
    __cmd__sockscap_helper_start, __tauri_command_name_sockscap_helper_start,
};

pub use status::{sockscap_helper_probe_windivert, sockscap_helper_status, sockscap_helper_stop};

pub(crate) use status::{
    __cmd__sockscap_helper_probe_windivert, __cmd__sockscap_helper_status,
    __cmd__sockscap_helper_stop, __tauri_command_name_sockscap_helper_probe_windivert,
    __tauri_command_name_sockscap_helper_status, __tauri_command_name_sockscap_helper_stop,
};

pub use requests::{send_json, send_json_timeout};

pub use capture_commands::{
    capture_start, capture_stop, capture_update_bypass, capture_update_relay,
};

pub use original_destination::{lookup_orig, lookup_orig_key};

pub use client::HelperClient;
