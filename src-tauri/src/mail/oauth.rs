mod commands;

mod tokens;

mod exchange;

mod http;
mod transport;

mod callback;

mod endpoints;

pub use commands::{mail_oauth_authorize, mail_oauth_device_complete, mail_oauth_device_start};

pub(crate) use commands::{
    __cmd__mail_oauth_authorize, __cmd__mail_oauth_device_complete, __cmd__mail_oauth_device_start,
    __tauri_command_name_mail_oauth_authorize, __tauri_command_name_mail_oauth_device_complete,
    __tauri_command_name_mail_oauth_device_start,
};

pub(super) use tokens::{
    oauth_reauthorize_required_message, oauth_refresh_error_message, oauth_refresh_scope,
    oauth_token_expired, persist_new_oauth_token, persist_oauth_token_bundle,
    read_oauth_token_bundle, resolve_oauth_access_token,
};

pub(super) use exchange::{
    complete_oauth_device_code_blocking, exchange_oauth_code_blocking,
    refresh_oauth_token_blocking, run_outside_tokio_context, start_oauth_device_code_blocking,
};

pub(super) use http::{
    build_oauth_http_client_blocking, oauth_form_body, parse_oauth_device_code_response,
    parse_oauth_token_response,
};

pub(super) use callback::{
    build_oauth_authorize_url, oauth_loopback_bind_host, oauth_loopback_redirect_uri,
    wait_for_oauth_callback,
};

pub(super) use endpoints::{
    oauth_authorize_url, oauth_device_code_url, oauth_scope, oauth_token_url, pkce_challenge,
    random_urlsafe_token,
};
