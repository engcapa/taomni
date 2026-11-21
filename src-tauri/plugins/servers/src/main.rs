fn main() {
    if let Err(error) = taomni_plugin_servers::serve() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
