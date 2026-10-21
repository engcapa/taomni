//! ASR installation is explicit, serialized and verified before atomic publication.

mod installation;

mod proxy;

mod inventory;

mod sherpa_inventory;

mod sherpa_install;

mod download;

mod install;

#[cfg(test)]
mod tests;

pub use installation::{
    InstallationProgress, voice_cancel_model_installation, voice_cancel_sherpa_model_installation,
    voice_model_installation,
};

pub(crate) use installation::{
    __cmd__voice_cancel_model_installation, __cmd__voice_cancel_sherpa_model_installation,
    __cmd__voice_model_installation, __tauri_command_name_voice_cancel_model_installation,
    __tauri_command_name_voice_cancel_sherpa_model_installation,
    __tauri_command_name_voice_model_installation,
};

pub use proxy::DownloadProxyConfig;

pub use inventory::{ModelStatus, voice_check_models, voice_models};

pub(crate) use inventory::{
    __cmd__voice_check_models, __cmd__voice_models, __tauri_command_name_voice_check_models,
    __tauri_command_name_voice_models,
};

pub use sherpa_inventory::{
    SHERPA_UPSTREAM_REVISION, SherpaFileStatus, SherpaModelStatus, voice_sherpa_model_status,
};

pub(crate) use sherpa_inventory::sherpa_model_dir;

pub(crate) use sherpa_inventory::{
    __cmd__voice_sherpa_model_status, __tauri_command_name_voice_sherpa_model_status,
};

pub use sherpa_install::{
    SherpaInstallationProgress, voice_install_sherpa_model, voice_sherpa_model_installation,
};

pub(crate) use sherpa_install::{
    __cmd__voice_install_sherpa_model, __cmd__voice_sherpa_model_installation,
    __tauri_command_name_voice_install_sherpa_model,
    __tauri_command_name_voice_sherpa_model_installation,
};

pub use install::voice_install_model;

pub(crate) use install::{__cmd__voice_install_model, __tauri_command_name_voice_install_model};
