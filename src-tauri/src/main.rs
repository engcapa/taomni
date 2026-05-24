// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    // CC bridge spawns this same binary with --mcp-server <name> as a subprocess
    // so the .mcp.json file can reference exactly one executable. Switching on
    // the first non-program argument lets us reuse the same build artefact for
    // both the desktop app and the stdio MCP servers.
    if args.len() >= 3 && args[1] == "--mcp-server" {
        match args[2].as_str() {
            "permissions" => {
                let _ = newmob_lib::agent::cc_bridge::permissions_mcp::run_stdio();
                std::process::exit(0);
            }
            "tools" => {
                let _ = newmob_lib::agent::cc_bridge::tools_mcp::run_stdio();
                std::process::exit(0);
            }
            other => {
                eprintln!("Unknown --mcp-server target: {other}");
                std::process::exit(2);
            }
        }
    }
    newmob_lib::run();
}
