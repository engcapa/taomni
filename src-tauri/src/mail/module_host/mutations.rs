//! Keep the signed mutation session alive while the caller journals each batch.

use std::{sync::Arc, time::Duration};

use taomni_mail_api::{
    HOST_REQUEST_TIMEOUT, OPEN_IMAP_MUTATIONS,
    imap_exchange::{read_body_frame, write_frame},
    imap_mutation::{
        ImapMutationJob, MutationError, MutationProgress, MutationReply, MutationRequest,
        OpenImapMutationJob, RUN_IMAP_MUTATION_JOB,
    },
};

use taomni_plugin_stream::routed_tcp::Route;

use super::{
    HostedImap, PluginRegistry, ResolvedMailAccount, bind_incoming, decode_imap_reply, invoke,
    supports,
};

pub(in crate::mail) struct HostedMutations<'a> {
    registry: &'a Arc<PluginRegistry>,
    account: &'a ResolvedMailAccount,
    runtime: &'a tokio::runtime::Handle,
    connection: Option<HostedImap>,
}

impl<'a> HostedMutations<'a> {
    pub(in crate::mail) fn for_registry(
        registry: &'a Arc<PluginRegistry>,
        account: &'a ResolvedMailAccount,
        runtime: &'a tokio::runtime::Handle,
    ) -> Option<Self> {
        supports(registry, OPEN_IMAP_MUTATIONS).then_some(Self {
            registry,
            account,
            runtime,
            connection: None,
        })
    }

    pub(in crate::mail) fn query(
        &mut self,
        request: MutationRequest,
    ) -> Result<MutationReply, MutationError> {
        self.runtime.block_on(async {
            tokio::time::timeout(HOST_REQUEST_TIMEOUT + Duration::from_secs(5), async {
                if self.connection.is_none() {
                    self.connection = Some(
                        HostedImap::open(self.registry.clone(), self.account, OPEN_IMAP_MUTATIONS)
                            .await?,
                    );
                }
                self.connection
                    .as_mut()
                    .expect("verified Mail mutation session")
                    .query(request)
                    .await
            })
            .await
            .map_err(|_| MutationError::unavailable("Mail mutation request timed out"))?
            .map_err(MutationError::unavailable)?
        })
    }
}

pub(in crate::mail) async fn run_owned_job(
    registry: &Arc<PluginRegistry>,
    account: &ResolvedMailAccount,
    request: ImapMutationJob,
) -> Result<MutationProgress, String> {
    let (_incoming, connection) = bind_incoming(account).await?;
    let (_exchange, exchange, mut peer) = Route::pair().await.map_err(|error| error.to_string())?;
    let request = serde_json::to_vec(&request).map_err(|error| error.to_string())?;
    invoke::<(), _>(
        registry.clone(),
        RUN_IMAP_MUTATION_JOB,
        OpenImapMutationJob {
            connection,
            exchange,
        },
    )
    .await?;
    write_frame(&mut peer, &request)
        .await
        .map_err(|error| error.to_string())?;
    let reply = read_body_frame(&mut peer)
        .await
        .map_err(|error| error.to_string())?;
    decode_imap_reply(reply).await
}

pub(in crate::mail) fn owns_mutation_journal(registry: &PluginRegistry) -> bool {
    supports(registry, RUN_IMAP_MUTATION_JOB)
}
