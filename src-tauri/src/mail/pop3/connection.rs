use taomni_mail_engine::pop3::{Pop3Connection, Pop3Session};

use super::limits::READ_TIMEOUT;
use crate::mail::{ProxyForward, ResolvedMailAccount, mail_effective_endpoint, tcp_connect};

pub(in crate::mail) struct Pop3Client {
    pub(in crate::mail) session: Pop3Session,
    _forward: Option<ProxyForward>,
}

impl Pop3Client {
    pub(in crate::mail) fn connect(
        account: &ResolvedMailAccount,
        runtime: &tokio::runtime::Handle,
    ) -> Result<Self, String> {
        let host = account.config.imap.host.trim();
        let (connect_host, connect_port, forward) =
            mail_effective_endpoint(account, host, account.config.imap.port, runtime)?;
        let stream = tcp_connect(&connect_host, connect_port)?;
        stream.set_read_timeout(Some(READ_TIMEOUT)).ok();
        stream.set_write_timeout(Some(READ_TIMEOUT)).ok();
        let session = Pop3Session::open(
            stream,
            &Pop3Connection {
                server_name: host,
                security: account.config.imap.security,
                trusted_certificate: account.config.imap.trusted_cert.as_deref(),
                username: &account.imap_username,
                secret: &account.imap_password,
                authentication: account.auth_mode,
            },
        )?;
        Ok(Self {
            session,
            _forward: forward,
        })
    }

    pub(in crate::mail) fn quit(self) -> Result<(), String> {
        self.session.quit()
    }
}
