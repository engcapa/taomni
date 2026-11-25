//! A single authenticated connection over a desktop-owned network route.

use std::{io, net::Ipv4Addr, time::Duration};

use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    task::JoinHandle,
    time::{Instant, timeout_at},
};
use uuid::Uuid;
use zeroize::Zeroizing;

const TOKEN_LEN: usize = 64;
const READY: u8 = 1;
const ACCEPT_TIMEOUT: Duration = Duration::from_secs(15);
const AUTH_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ForwardRoute {
    port: u16,
    token: Zeroizing<String>,
}

impl ForwardRoute {
    pub async fn bind(
        upstream: impl AsyncRead + AsyncWrite + Unpin + Send + 'static,
    ) -> io::Result<(Self, JoinHandle<()>)> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
        let route = Self::new(listener.local_addr()?.port());
        let server = route.clone();
        let task = tokio::spawn(async move {
            if let Err(error) = server.serve(listener, upstream).await {
                tracing::debug!(%error, "VNC forward closed");
            }
        });
        Ok((route, task))
    }

    fn new(port: u16) -> Self {
        Self {
            port,
            token: Zeroizing::new(format!(
                "{}{}",
                Uuid::new_v4().simple(),
                Uuid::new_v4().simple()
            )),
        }
    }

    pub fn is_valid(&self) -> bool {
        self.port != 0
            && self.token.len() == TOKEN_LEN
            && self.token.bytes().all(|byte| byte.is_ascii_hexdigit())
    }

    pub async fn connect(self) -> io::Result<TcpStream> {
        let mut socket = TcpStream::connect((Ipv4Addr::LOCALHOST, self.port)).await?;
        socket.set_nodelay(true)?;
        socket.write_all(self.token.as_bytes()).await?;
        if socket.read_u8().await? != READY {
            return Err(io::Error::other(
                "VNC bridge refused the forwarded connection",
            ));
        }
        Ok(socket)
    }

    async fn serve(
        self,
        listener: TcpListener,
        upstream: impl AsyncRead + AsyncWrite + Unpin,
    ) -> io::Result<()> {
        let deadline = Instant::now() + ACCEPT_TIMEOUT;
        let local = loop {
            let (mut stream, _) = timeout_at(deadline, listener.accept()).await??;
            let auth_deadline = deadline.min(Instant::now() + AUTH_TIMEOUT);
            let mut supplied = Zeroizing::new([0_u8; TOKEN_LEN]);
            let received = timeout_at(auth_deadline, stream.read_exact(supplied.as_mut())).await;
            if !matches!(received, Ok(Ok(TOKEN_LEN)))
                || !bool::from(supplied.as_ref().ct_eq(self.token.as_bytes()))
            {
                continue;
            }
            stream.set_nodelay(true)?;
            timeout_at(auth_deadline, stream.write_u8(READY)).await??;
            break stream;
        };
        drop(listener);

        // Either EOF ends this VNC session and releases both endpoints.
        let (mut local_read, mut local_write) = local.into_split();
        let (mut upstream_read, mut upstream_write) = tokio::io::split(upstream);
        tokio::select! {
            result = tokio::io::copy(&mut local_read, &mut upstream_write) => result.map(|_| ()),
            result = tokio::io::copy(&mut upstream_read, &mut local_write) => result.map(|_| ()),
        }
    }
}

/// Aborts a forwarding task when its connection attempt ends.
pub struct ForwardTaskGuard(Option<JoinHandle<()>>);

impl ForwardTaskGuard {
    pub fn new(task: Option<JoinHandle<()>>) -> Self {
        Self(task)
    }

    pub fn take(&mut self) -> Option<JoinHandle<()>> {
        self.0.take()
    }
}

impl Drop for ForwardTaskGuard {
    fn drop(&mut self) {
        if let Some(task) = self.0.as_ref() {
            task.abort();
        }
    }
}
