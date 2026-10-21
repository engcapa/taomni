//! LanChat Tauri command surface (`lanchat_*`).
//!
//! Single backend entry point for the frontend IPC layer (`src/lib/ipc.ts`).
//! Commands are added per phase; phase 1 ships only a lightweight status probe
//! used by the status bar / web-preview banner.

mod readiness;

mod profile;

mod messages;

mod transfers;

mod media;

mod images;

mod retention;

mod service;

pub use profile::{
    LanChatStatus, PinnedPeer, UpdateProfileArgs, lanchat_get_profile, lanchat_list_peers,
    lanchat_list_pinned, lanchat_retrust_peer, lanchat_status, lanchat_update_profile,
};

pub(crate) use profile::{
    __cmd__lanchat_get_profile, __cmd__lanchat_list_peers, __cmd__lanchat_list_pinned,
    __cmd__lanchat_retrust_peer, __cmd__lanchat_status, __cmd__lanchat_update_profile,
    __tauri_command_name_lanchat_get_profile, __tauri_command_name_lanchat_list_peers,
    __tauri_command_name_lanchat_list_pinned, __tauri_command_name_lanchat_retrust_peer,
    __tauri_command_name_lanchat_status, __tauri_command_name_lanchat_update_profile,
};

pub use messages::{
    CreateGroupArgs, SendGroupTextArgs, SendTextArgs, lanchat_create_group, lanchat_leave_group,
    lanchat_list_conversations, lanchat_list_groups, lanchat_list_messages, lanchat_mark_read,
    lanchat_resend_message, lanchat_send_group_text, lanchat_send_text,
};

pub(crate) use messages::{
    __cmd__lanchat_create_group, __cmd__lanchat_leave_group, __cmd__lanchat_list_conversations,
    __cmd__lanchat_list_groups, __cmd__lanchat_list_messages, __cmd__lanchat_mark_read,
    __cmd__lanchat_resend_message, __cmd__lanchat_send_group_text, __cmd__lanchat_send_text,
    __tauri_command_name_lanchat_create_group, __tauri_command_name_lanchat_leave_group,
    __tauri_command_name_lanchat_list_conversations, __tauri_command_name_lanchat_list_groups,
    __tauri_command_name_lanchat_list_messages, __tauri_command_name_lanchat_mark_read,
    __tauri_command_name_lanchat_resend_message, __tauri_command_name_lanchat_send_group_text,
    __tauri_command_name_lanchat_send_text,
};

pub use transfers::{
    lanchat_accept_file, lanchat_open_path, lanchat_reject_file, lanchat_send_dir,
    lanchat_send_file, lanchat_send_group_file, lanchat_send_signal, lanchat_signal_group,
    lanchat_transfer_control,
};

pub(crate) use transfers::{
    __cmd__lanchat_accept_file, __cmd__lanchat_open_path, __cmd__lanchat_reject_file,
    __cmd__lanchat_send_dir, __cmd__lanchat_send_file, __cmd__lanchat_send_group_file,
    __cmd__lanchat_send_signal, __cmd__lanchat_signal_group, __cmd__lanchat_transfer_control,
    __tauri_command_name_lanchat_accept_file, __tauri_command_name_lanchat_open_path,
    __tauri_command_name_lanchat_reject_file, __tauri_command_name_lanchat_send_dir,
    __tauri_command_name_lanchat_send_file, __tauri_command_name_lanchat_send_group_file,
    __tauri_command_name_lanchat_send_signal, __tauri_command_name_lanchat_signal_group,
    __tauri_command_name_lanchat_transfer_control,
};

pub use media::{
    nmedia_add_peer, nmedia_peer_state, nmedia_remove_peer, nmedia_start, nmedia_stop,
    nmedia_toggle_cam, nmedia_toggle_mic, nmedia_toggle_screen, nmedia_ws_port,
};

pub(crate) use media::{
    __cmd__nmedia_add_peer, __cmd__nmedia_peer_state, __cmd__nmedia_remove_peer,
    __cmd__nmedia_start, __cmd__nmedia_stop, __cmd__nmedia_toggle_cam, __cmd__nmedia_toggle_mic,
    __cmd__nmedia_toggle_screen, __cmd__nmedia_ws_port, __tauri_command_name_nmedia_add_peer,
    __tauri_command_name_nmedia_peer_state, __tauri_command_name_nmedia_remove_peer,
    __tauri_command_name_nmedia_start, __tauri_command_name_nmedia_stop,
    __tauri_command_name_nmedia_toggle_cam, __tauri_command_name_nmedia_toggle_mic,
    __tauri_command_name_nmedia_toggle_screen, __tauri_command_name_nmedia_ws_port,
};

pub use images::{lanchat_send_clipboard_image, lanchat_send_image_bytes, lanchat_send_screenshot};

pub(crate) use images::{
    __cmd__lanchat_send_clipboard_image, __cmd__lanchat_send_image_bytes,
    __cmd__lanchat_send_screenshot, __tauri_command_name_lanchat_send_clipboard_image,
    __tauri_command_name_lanchat_send_image_bytes, __tauri_command_name_lanchat_send_screenshot,
};

pub use retention::{
    lanchat_clear_all_history, lanchat_clear_conversation, lanchat_delete_message,
    lanchat_get_retention, lanchat_set_retention,
};

pub(crate) use retention::{
    __cmd__lanchat_clear_all_history, __cmd__lanchat_clear_conversation,
    __cmd__lanchat_delete_message, __cmd__lanchat_get_retention, __cmd__lanchat_set_retention,
    __tauri_command_name_lanchat_clear_all_history,
    __tauri_command_name_lanchat_clear_conversation, __tauri_command_name_lanchat_delete_message,
    __tauri_command_name_lanchat_get_retention, __tauri_command_name_lanchat_set_retention,
};

pub use service::{
    LanChatServiceState, lanchat_get_service_state, lanchat_set_start_on_launch,
    lanchat_start_service,
};

pub(crate) use service::{
    __cmd__lanchat_get_service_state, __cmd__lanchat_set_start_on_launch,
    __cmd__lanchat_start_service, __tauri_command_name_lanchat_get_service_state,
    __tauri_command_name_lanchat_set_start_on_launch, __tauri_command_name_lanchat_start_service,
};
