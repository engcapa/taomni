#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

use std::process::ExitCode;

fn main() -> ExitCode {
    match taomni_plugin_mfa::serve_stdio() {
        Ok(()) => ExitCode::SUCCESS,
        Err(_) => {
            // Do not print inputs, core replies, keys or filesystem paths.
            eprintln!("MFA host failed to start or lost its control channel");
            ExitCode::FAILURE
        }
    }
}
