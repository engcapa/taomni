use std::process::ExitCode;

fn main() -> ExitCode {
    if taomni_plugin_vnc_server::serve().is_ok() {
        ExitCode::SUCCESS
    } else {
        eprintln!("VNC server host failed to start or lost its control channel");
        ExitCode::FAILURE
    }
}
