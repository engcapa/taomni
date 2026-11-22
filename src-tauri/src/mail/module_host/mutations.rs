//! Keep the signed mutation session alive while the caller journals each batch.

use std::{sync::Arc, time::Duration};

use taomni_mail_api::{
    HOST_REQUEST_TIMEOUT, OPEN_IMAP_MUTATIONS,
    imap_mutation::{MutationError, MutationReply, MutationRequest},
};

use super::{HostedImap, PluginRegistry, ResolvedMailAccount, supports};

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
