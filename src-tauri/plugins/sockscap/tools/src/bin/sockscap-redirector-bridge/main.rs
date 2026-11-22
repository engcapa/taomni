fn main() {
    #[cfg(target_os = "macos")]
    std::process::exit(taomni_sockscap_tools::redirector_bridge::run_from_cli(
        std::env::args().skip(1),
        false,
    ));
    #[cfg(not(target_os = "macos"))]
    std::process::exit(2);
}
