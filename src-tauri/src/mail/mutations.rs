//! Adapt the desktop and signed IMAP sessions to the durable mutation journal.

use super::*;
use crate::{plugin::PluginRegistry, state::MailDbHandle};
use taomni_mail_api::imap_mutation::{MutationError, MutationReply, MutationRequest};
use taomni_mail_engine::mutation_journal::{
    MutationJobRequest, MutationSession, SendMutation, run_mutation,
};

pub(super) use taomni_mail_api::imap_mutation::MutationKind as Kind;
pub use taomni_mail_api::imap_mutation::MutationProgress as Progress;

#[cfg(test)]
use taomni_mail_engine::mutation_journal::COMMAND_BYTES;

fn legacy_query(
    imap: &mut ActiveImapSession,
    request: MutationRequest,
) -> Result<MutationReply, MutationError> {
    use taomni_mail_engine::mutation_transport::execute;
    match imap {
        ActiveImapSession::Tls { session, .. } => execute(session, request),
        ActiveImapSession::Plain { session, .. } => execute(session, request),
    }
}

struct DesktopSession<'a> {
    pool: &'a MailImapPool,
    account: &'a ResolvedMailAccount,
    runtime: &'a tokio::runtime::Handle,
    hosted: Option<module_host::HostedMutations<'a>>,
}

impl MutationSession for DesktopSession<'_> {
    fn with_session<T>(
        &mut self,
        mut operation: impl FnMut(&mut SendMutation<'_>) -> Result<T, String>,
    ) -> Result<T, String> {
        if let Some(host) = &mut self.hosted {
            return operation(&mut |request| host.query(request));
        }
        let opts = ImapSessionOpts {
            retry_on_error: false,
            ..Default::default()
        };
        with_imap_session(self.pool, self.account, self.runtime, opts, |imap| {
            operation(&mut |request| legacy_query(imap, request))
        })
    }
}

pub(super) fn run_cached(
    pool: &MailImapPool,
    gate: &std::sync::Mutex<()>,
    account: &ResolvedMailAccount,
    runtime: &tokio::runtime::Handle,
    db: &MailDbHandle,
    folder: &str,
    uids: Vec<u32>,
    target: &str,
    kind: Kind,
    all: bool,
    operation_id: Option<String>,
    registry: Option<&Arc<PluginRegistry>>,
) -> Result<Progress, String> {
    let account_id = &account.config.session_id;
    let _guard = gate.lock().map_err(|_| "mail mutation lock poisoned")?;
    let endpoint = format!(
        "{}:{}:{}",
        account.config.imap.host.trim(),
        account.config.imap.port,
        account.imap_username
    );
    let mut session = DesktopSession {
        pool,
        account,
        runtime,
        hosted: registry.and_then(|registry| {
            module_host::HostedMutations::for_registry(registry, account, runtime)
        }),
    };
    run_mutation(
        db,
        &mut session,
        MutationJobRequest {
            account_id,
            endpoint: &endpoint,
            folder,
            target,
            uids,
            kind,
            all,
            operation_id,
        },
    )
}

#[cfg(test)]
mod tests;
