//! The signed host holds the account's write-ahead journal through each IMAP job.

use std::{
    net::{Shutdown, TcpStream as BlockingStream},
    sync::{Arc, Mutex},
    time::Duration,
};

use taomni_mail_api::{
    IncomingTest, MailIncomingProtocol,
    imap_exchange::{read_frame, write_body_frame},
    imap_mutation::{
        ImapMutationJob, MutationError, MutationProgress, MutationReply, MutationRequest,
        OpenImapMutationJob,
    },
};
use taomni_mail_engine::{
    cache::init_mail_tables,
    database::{MAIL_MUTATION_LOCK, MailDatabase, ProcessLock},
    imap_transport::{ImapSession, imap_catch_result},
    mutation_journal::{
        MutationJobRequest, MutationSession, SendMutation, run_mutation_under_lease,
    },
};
use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_plugin_sdk::Operation;
use taomni_plugin_stream::CancellationToken;
use tokio::{
    io::AsyncReadExt,
    net::TcpStream,
    runtime::{Handle, Runtime},
    sync::{OwnedRwLockReadGuard, RwLock},
};

use super::{
    account_cache::lock_account_cache,
    incoming::{configure, open_imap, while_current},
    store::validate_account,
};

pub(super) fn start(
    runtime: &Runtime,
    operation: &Operation,
    request: OpenImapMutationJob,
    activity: Arc<RwLock<()>>,
) -> Result<Result<(), String>, RpcError> {
    let OpenImapMutationJob {
        connection,
        exchange,
    } = request;
    if connection.protocol != MailIncomingProtocol::Imap
        || connection.server_name.trim().is_empty()
        || connection.username.trim().is_empty()
    {
        return Err(RpcError::from_code(ErrorCode::InvalidParams));
    }
    let (stream, _) = match runtime.block_on(while_current(operation, exchange.connect()))? {
        Ok(pair) => pair,
        Err(error) => return Ok(Err(error)),
    };
    operation.check_current()?;
    let lease = activity
        .try_read_owned()
        .map_err(|_| RpcError::new(ErrorCode::InvalidState, "Mail snapshot is in progress"))?;
    runtime.spawn(async move {
        let _ = serve(stream, connection, lease).await;
    });
    Ok(Ok(()))
}

async fn serve(
    mut stream: TcpStream,
    connection: IncomingTest,
    activity: OwnedRwLockReadGuard<()>,
) -> std::io::Result<()> {
    let input = tokio::time::timeout(Duration::from_secs(5), read_frame(&mut stream)).await??;
    let request: ImapMutationJob = serde_json::from_slice(&input).map_err(std::io::Error::other)?;
    validate_account(&request.account_id).map_err(|error| std::io::Error::other(error.message))?;
    let (mut client, mut reply) = stream.into_split();

    let cancellation = Arc::new(JobCancellation::default());
    let runtime = Handle::current();
    let worker_cancellation = cancellation.clone();
    let mut worker = tokio::task::spawn_blocking(move || {
        let _activity = activity;
        execute(runtime, connection, request, worker_cancellation)
    });
    let result = tokio::select! {
        result = &mut worker => result.map_err(std::io::Error::other)?,
        _ = client.read_u8() => {
            cancellation.cancel();
            let _ = worker.await;
            return Ok(());
        },
    };
    send_reply(&mut reply, result).await
}

async fn send_reply(
    reply: &mut (impl tokio::io::AsyncWrite + Unpin),
    result: Result<MutationProgress, String>,
) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(&result).map_err(std::io::Error::other)?;
    write_body_frame(reply, &bytes).await
}

fn execute(
    runtime: Handle,
    connection: IncomingTest,
    request: ImapMutationJob,
    cancellation: Arc<JobCancellation>,
) -> Result<MutationProgress, String> {
    let lease = {
        let _access = lock_account_cache(&request.database, &request.account_id)?;
        ProcessLock::try_at(&request.database, MAIL_MUTATION_LOCK)?
            .ok_or("Another Taomni instance is changing this mailbox. Retry once the other operation finishes")?
    };
    let db = MailDatabase::new(request.database, init_mail_tables);
    let mut session = HostMutationSession {
        runtime,
        connection,
        cancellation,
        session: None,
    };
    run_mutation_under_lease(
        &db,
        &mut session,
        MutationJobRequest {
            account_id: &request.account_id,
            endpoint: &request.server_identity,
            folder: &request.folder,
            target: &request.target,
            uids: request.uids,
            kind: request.kind,
            all: request.all,
            operation_id: request.operation_id,
        },
        lease,
    )
}

#[derive(Default)]
struct JobCancellation {
    token: CancellationToken,
    socket: Mutex<Option<BlockingStream>>,
}

impl JobCancellation {
    fn cancel(&self) {
        self.token.cancel();
        if let Ok(mut socket) = self.socket.lock()
            && let Some(socket) = socket.take()
        {
            let _ = socket.shutdown(Shutdown::Both);
        }
    }

    fn watch_socket(&self, socket: &BlockingStream) -> Result<(), String> {
        let mut active = self.socket.lock().map_err(|error| error.to_string())?;
        if self.token.is_cancelled() {
            return Err("Mail mutation was cancelled".into());
        }
        *active = Some(socket.try_clone().map_err(|error| error.to_string())?);
        Ok(())
    }
}

struct HostMutationSession {
    runtime: Handle,
    connection: IncomingTest,
    cancellation: Arc<JobCancellation>,
    session: Option<ImapSession>,
}

impl HostMutationSession {
    fn connect(&self) -> Result<ImapSession, String> {
        let (stream, _) = self.runtime.block_on(async {
            tokio::select! {
                biased;
                _ = self.cancellation.token.cancelled() => Err("Mail mutation was cancelled".into()),
                connected = self.connection.route.connect() => connected,
            }
        })?;
        let stream = stream.into_std().map_err(|error| error.to_string())?;
        configure(&stream, MailIncomingProtocol::Imap).map_err(|error| error.message)?;
        self.cancellation.watch_socket(&stream)?;
        imap_catch_result(|| open_imap(stream, &self.connection))
    }

    fn query(&mut self, request: MutationRequest) -> Result<MutationReply, MutationError> {
        if self.cancellation.token.is_cancelled() {
            return Err(MutationError::unavailable("Mail mutation was cancelled"));
        }
        if self.session.is_none() {
            self.session = Some(self.connect().map_err(MutationError::unavailable)?);
        }
        let session = self.session.as_mut().expect("connected mutation session");
        imap_catch_result(|| Ok(session.mutate(request))).map_err(MutationError::unavailable)?
    }
}

impl MutationSession for HostMutationSession {
    fn with_session<T>(
        &mut self,
        mut operation: impl FnMut(&mut SendMutation<'_>) -> Result<T, String>,
    ) -> Result<T, String> {
        operation(&mut |request| self.query(request))
    }
}
