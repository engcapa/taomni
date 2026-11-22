//! Desktop archive transport selection. The Mail engine owns the scan and database writes.
use super::{connection::HostedConnection, lifetime::ArchiveJob};
use crate::{
    mail::{ResolvedMailAccount, connect_imap_with_socket, module_host},
    state::AppState,
};
use taomni_mail_engine::archive::{scanner::ArchiveConnection, writer::ArchiveMailbox};

pub(super) fn run(
    state: &AppState,
    account: &ResolvedMailAccount,
    runtime: &tokio::runtime::Handle,
    job: &ArchiveJob,
    mailbox: &ArchiveMailbox<'_>,
) -> Result<(), String> {
    // A cancellable connection owned by this job cannot stall interactive or
    // header/body-prefetch lanes, and is dropped when the job stops.
    let mut hosted;
    let mut legacy;
    let (imap, condstore): (&mut dyn ArchiveConnection, bool) =
        if module_host::archives_imap(&state.plugins) {
            hosted = HostedConnection::open(state.plugins.clone(), account, runtime, job)?;
            (&mut hosted, false)
        } else {
            let (session, socket) = connect_imap_with_socket(account, runtime)?;
            *job.socket.lock().map_err(|e| e.to_string())? = socket;
            legacy = session;
            let condstore = legacy.has_capability("CONDSTORE");
            (&mut legacy, condstore)
        };
    mailbox.run_imap(imap, &account.config.cache, condstore)
}
