use std::{io, sync::Arc, time::Duration};
use taomni_plugin_sdk::{HostConfig, serve_stdio_with};

mod sessions;
mod transcode;

const COMMANDS: [&str; 6] = [
    "media/begin",
    "media/append",
    "media/convert",
    "media/status",
    "media/read",
    "media/close",
];

fn main() -> io::Result<()> {
    ffmpeg_next::init().map_err(io::Error::other)?;
    ffmpeg_next::log::set_level(ffmpeg_next::log::Level::Quiet);
    serve_stdio_with(
        HostConfig {
            plugin_id: "taomni-plugin-taoffice-video".into(),
            plugin_version: env!("CARGO_PKG_VERSION").into(),
            commands: COMMANDS.map(str::to_owned).into_iter().collect(),
            permissions: ["fs.readUserFile".into()].into_iter().collect(),
            required_services: Default::default(),
            optional_services: Default::default(),
            operation_timeout: Duration::from_secs(10),
            snapshot_timeout: Duration::from_secs(10),
        },
        |storage| {
            storage.ok_or_else(|| io::Error::other("TaOffice Media requires a profile lease"))?;
            Ok(Arc::new(sessions::MediaJobs::default()))
        },
    )
}
