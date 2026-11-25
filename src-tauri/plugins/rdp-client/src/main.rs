fn main() -> std::process::ExitCode {
    match taomni_plugin_rdp_client::serve_stdio() {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("RDP host: {error}");
            std::process::ExitCode::FAILURE
        }
    }
}
