#[cfg(windows)]
mod windows;

fn main() {
    #[cfg(windows)]
    {
        let mut args = std::env::args().skip(1);
        let parent = args.next().and_then(|pid| pid.parse::<u32>().ok());
        match (parent, args.next()) {
            (Some(pid), None) if pid != 0 => std::process::exit(windows::run(pid)),
            _ => {
                eprintln!("The VNC key helper requires the parent process ID");
                std::process::exit(2);
            }
        }
    }
    #[cfg(not(windows))]
    std::process::exit(2);
}
