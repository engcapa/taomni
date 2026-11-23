//! Desktop archive transport selection. The Mail engine owns the scan and database writes.
use super::{connection::HostedConnection, lifetime::ArchiveJob};
use crate::{
    mail::{ResolvedMailAccount, module_host},
    state::AppState,
};
use taomni_mail_engine::archive::writer::ArchiveMailbox;

pub(super) fn run(
    state: &AppState,
    account: &ResolvedMailAccount,
    runtime: &tokio::runtime::Handle,
    job: &ArchiveJob,
    mailbox: &ArchiveMailbox<'_>,
) -> Result<(), String> {
    // A cancellable connection owned by this job cannot stall interactive or
    // header/body-prefetch lanes, and is dropped when the job stops.
    if module_host::archives_imap(&state.plugins) {
        let mut hosted = HostedConnection::open(state.plugins.clone(), account, runtime, job)?;
        return mailbox.run_imap(&mut hosted, &account.config.cache, false);
    }
    legacy_imap!({
        let (mut legacy, socket) = crate::mail::connect_imap_with_socket(account, runtime)?;
        *job.socket.lock().map_err(|e| e.to_string())? = socket;
        let condstore = legacy.has_capability("CONDSTORE");
        mailbox.run_imap(&mut legacy, &account.config.cache, condstore)
    })
}
