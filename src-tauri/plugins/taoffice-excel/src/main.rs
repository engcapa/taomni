use std::{io, sync::Arc, time::Duration};
use taomni_plugin_sdk::{HostConfig, serve_stdio_with};

mod legacy_workbook;
mod sessions;
mod workbook;
mod workbook_copy;
mod workbook_package;

const ID: &str = "taomni-plugin-taoffice-excel";
const COMMANDS: [&str; 8] = [
    "workbook/begin",
    "workbook/append",
    "workbook/open",
    "workbook/sheet",
    "workbook/close",
    "workbook/copy",
    "workbook/copyChunk",
    "workbook/releaseCopy",
];

fn main() -> io::Result<()> {
    let config = HostConfig {
        plugin_id: ID.into(),
        plugin_version: env!("CARGO_PKG_VERSION").into(),
        commands: COMMANDS.map(str::to_owned).into_iter().collect(),
        permissions: ["fs.readUserFile".into()].into_iter().collect(),
        required_services: Default::default(),
        optional_services: Default::default(),
        operation_timeout: Duration::from_secs(25),
        snapshot_timeout: Duration::from_secs(10),
    };
    serve_stdio_with(config, |storage| {
        storage.ok_or_else(|| io::Error::other("TaOffice Excel requires a profile lease"))?;
        Ok(Arc::new(sessions::Workbooks::new()?))
    })
}
