//! Adapt the desktop and signed IMAP sessions to the durable mutation journal.

use super::*;
use crate::{plugin::PluginRegistry, state::MailDbHandle};
use taomni_mail_api::imap_mutation::ImapMutationJob;
#[cfg(any(test, feature = "legacy-mail-imap"))]
use taomni_mail_api::imap_mutation::{MutationError, MutationReply, MutationRequest};
use taomni_mail_engine::mutation_journal::{
    MutationJobRequest, MutationSession, SendMutation, run_mutation,
};

pub(super) use taomni_mail_api::imap_mutation::MutationKind as Kind;
pub use taomni_mail_api::imap_mutation::MutationProgress as Progress;

#[cfg(test)]
use taomni_mail_engine::mutation_journal::COMMAND_BYTES;

#[cfg(any(test, feature = "legacy-mail-imap"))]
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
    #[cfg(any(test, feature = "legacy-mail-imap"))]
    pool: &'a MailImapPool,
    #[cfg(any(test, feature = "legacy-mail-imap"))]
    account: &'a ResolvedMailAccount,
    #[cfg(any(test, feature = "legacy-mail-imap"))]
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
        legacy_imap!({
            let opts = ImapSessionOpts {
                retry_on_error: false,
                ..Default::default()
            };
            with_imap_session(self.pool, self.account, self.runtime, opts, |imap| {
                operation(&mut |request| legacy_query(imap, request))
            })
        })
    }
}

pub(super) fn run_cached(
    #[cfg(any(test, feature = "legacy-mail-imap"))] pool: &MailImapPool,
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
    if let Some(registry) = registry.filter(|registry| module_host::owns_mutation_journal(registry))
    {
        let database = super::cache_access::canonical_cache_database(db)?;
        return runtime.block_on(module_host::run_owned_job(
            registry,
            account,
            ImapMutationJob {
                account_id: account_id.clone(),
                database,
                server_identity: endpoint,
                folder: folder.into(),
                target: target.into(),
                uids,
                kind,
                all,
                operation_id,
            },
        ));
    }
    let mut session = DesktopSession {
        #[cfg(any(test, feature = "legacy-mail-imap"))]
        pool,
        #[cfg(any(test, feature = "legacy-mail-imap"))]
        account,
        #[cfg(any(test, feature = "legacy-mail-imap"))]
        runtime,
        hosted: registry.and_then(|registry| {
            module_host::HostedMutations::for_registry(registry, account, runtime)
        }),
    };
    #[cfg(not(any(test, feature = "legacy-mail-imap")))]
    if session.hosted.is_none() {
        return Err(String::from(SIGNED_MAIL_CONNECTION_REQUIRED));
    }
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
