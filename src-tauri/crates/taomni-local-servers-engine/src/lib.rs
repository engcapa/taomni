//! Local server implementations shared by the desktop adapter and module host.

pub mod cron;
pub mod ftp;
pub mod http;
pub mod iperf;
pub mod nfs;
pub mod ssh;
pub mod telnet;
pub mod tftp;

use std::sync::Arc;

use taomni_server_process::Log;
pub use taomni_server_process::{ServerConfig, Started as ServerStarted};
use tokio_util::sync::CancellationToken;

pub struct ServerCtx {
    pub cancel: CancellationToken,
    pub log: LogEmitter,
}

impl ServerCtx {
    pub fn new(cancel: CancellationToken, log: impl Fn(String) + Send + Sync + 'static) -> Self {
        Self {
            cancel,
            log: LogEmitter(Arc::new(log)),
        }
    }
}

#[derive(Clone)]
pub struct LogEmitter(Log);

impl LogEmitter {
    fn line(&self, message: impl Into<String>) {
        (self.0)(message.into());
    }
}
