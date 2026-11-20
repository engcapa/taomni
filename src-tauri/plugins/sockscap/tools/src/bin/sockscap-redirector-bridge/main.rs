#[cfg(target_os = "macos")]
mod bridge;

fn main() {
    #[cfg(target_os = "macos")]
    std::process::exit(bridge::run_from_cli());
    #[cfg(not(target_os = "macos"))]
    std::process::exit(2);
}
