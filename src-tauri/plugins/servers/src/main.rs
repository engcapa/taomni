#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

fn main() {
    if let Err(error) = taomni_plugin_servers::serve() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
