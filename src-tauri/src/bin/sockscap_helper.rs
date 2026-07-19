#[cfg(target_os = "linux")]
#[tokio::main]
async fn main() {
    if let Err(error) = taomni_lib::sockscap::capture::linux_helper::run_from_args().await {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("SOCKSCAP_HELPER_UNAVAILABLE: this helper target currently supports Linux only");
    std::process::exit(1);
}
