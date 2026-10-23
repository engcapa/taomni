use crate::terminal::client;
use crate::terminal::ssh;
use std::io::Write;
use std::sync::Arc;
use std::sync::Mutex;
use tokio::sync::Mutex as AsyncMutex;
use tokio::task::JoinHandle;

pub enum ActiveTerminal {
    Local {
        _route: crate::database::forward::ForwardGuard,
        writer: Mutex<Box<dyn Write + Send>>,
        master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
        #[allow(dead_code)]
        child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    },
    Ssh {
        channel: Arc<AsyncMutex<russh::ChannelWriteHalf<russh::client::Msg>>>,
        #[allow(dead_code)]
        handle: Arc<russh::client::Handle<ssh::SshHandler>>,
        /// Listener tasks for any session-attached local port forwards.
        /// `close_terminal` aborts these to release the bound TCP ports.
        forwards: AsyncMutex<Vec<JoinHandle<()>>>,
    },
}

unsafe impl Send for ActiveTerminal {}
unsafe impl Sync for ActiveTerminal {}
