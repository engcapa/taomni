use std::process::ExitCode;

fn main() -> ExitCode {
    match taomni_plugin_screenshot::serve_stdio() {
        Ok(()) => ExitCode::SUCCESS,
        Err(_) => {
            eprintln!("Screenshot host failed to start or lost its control channel");
            ExitCode::FAILURE
        }
    }
}
