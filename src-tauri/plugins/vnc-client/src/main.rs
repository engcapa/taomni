#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

fn main() -> std::process::ExitCode {
    match taomni_plugin_vnc_client::serve_stdio() {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("VNC host: {error}");
            std::process::ExitCode::FAILURE
        }
    }
}
