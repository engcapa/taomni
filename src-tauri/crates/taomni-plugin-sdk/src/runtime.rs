//! Authentication/control stays in the reader; business work runs independently.
use crate::{
    HostStorage, Operation,
    client::ServiceClient,
    confirm_profile_handshake,
    sensitive::{Envelope, LineReader, invalid_frame},
};
use std::{
    collections::{BTreeSet, HashMap},
    io::{self, Read, Write},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::Duration,
};
use taomni_plugin_api::{
    CancelRequest, ErrorCode, HandshakeRequest, HandshakeResponse, Heartbeat, ReplayError,
    RequestId, RequestIdMode, RequestReplay, RpcError, RpcMessage, RpcRequest, RpcResponse,
    services::{
        HostInstanceId, RevokeKeys, RevokedKeys, ServiceCapabilities, VAULT_REVOKE_METHOD,
        VaultEpoch,
    },
    validate_token, validate_versions,
};

#[path = "worker.rs"]
mod worker;

/// Compiled official-host identity and required services. This is not populated
/// from a renderer, downloaded module.json or the incoming handshake itself.
pub struct HostConfig {
    pub plugin_id: String,
    pub plugin_version: String,
    pub commands: BTreeSet<String>,
    pub permissions: BTreeSet<String>,
    pub required_services: ServiceCapabilities,
    /// Additional services negotiated when the core offers the same version.
    pub optional_services: ServiceCapabilities,
    pub operation_timeout: Duration,
    pub snapshot_timeout: Duration,
}

pub trait PluginHandler: Send + Sync + 'static {
    fn snapshot_provider(&self) -> Option<Arc<dyn crate::SnapshotProvider>> {
        None
    }
    fn invoke(
        &self,
        operation: &Operation,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> Result<serde_json::Value, RpcError>;
}

pub(crate) type ActiveOperations = Arc<Mutex<HashMap<RequestId, Arc<Operation>>>>;

pub fn serve_stdio(config: HostConfig, handler: Arc<dyn PluginHandler>) -> io::Result<()> {
    serve_stdio_with(config, |_| Ok(handler))
}

/// Stateful official hosts must initialize their stores here, after native
/// ownership is acquired. The preconstructed-handler entry is for stateless
/// hosts; opening a database before this factory would precede its writer lock.
pub fn serve_stdio_with(
    config: HostConfig,
    initialize: impl FnOnce(Option<&HostStorage>) -> io::Result<Arc<dyn PluginHandler>>,
) -> io::Result<()> {
    let token = std::env::var("TAOMNI_PLUGIN_TOKEN")
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "plugin token required"))?;
    let storage = HostStorage::from_environment(&config.plugin_id)?.map(Arc::new);
    let handler = initialize(storage.as_deref())?;
    serve_owned(
        io::stdin().lock(),
        io::stdout(),
        token,
        config,
        handler,
        storage,
    )
}

pub fn serve(
    reader: impl Read,
    writer: impl Write + Send + 'static,
    token: String,
    config: HostConfig,
    handler: Arc<dyn PluginHandler>,
) -> io::Result<()> {
    serve_owned(reader, writer, token, config, handler, None)
}

pub(crate) fn serve_owned(
    reader: impl Read,
    writer: impl Write + Send + 'static,
    token: String,
    config: HostConfig,
    handler: Arc<dyn PluginHandler>,
    storage: Option<Arc<HostStorage>>,
) -> io::Result<()> {
    let (output, messages) = mpsc::sync_channel::<RpcMessage>(8);
    let writer_failed = Arc::new(AtomicBool::new(false));
    let failed = writer_failed.clone();
    std::thread::Builder::new()
        .name("plugin-sdk-writer".into())
        .spawn(move || {
            let mut writer = writer;
            while let Ok(message) = messages.recv() {
                let result = serde_json::to_writer(&mut writer, &message)
                    .map_err(io::Error::other)
                    .and_then(|()| writer.write_all(b"\n"))
                    .and_then(|()| writer.flush());
                if result.is_err() {
                    failed.store(true, Ordering::Release);
                    break;
                }
            }
        })?;
    let client = ServiceClient::new(output);
    let active = Arc::new(Mutex::new(HashMap::new()));
    let _cleanup = CancelOnExit(active.clone());
    let jobs = worker::start(active.clone(), client.clone(), handler, storage.clone())?;
    let mut reader = LineReader::new(reader);
    let mut authenticated = false;
    let mut scoped_commands = false;
    let mut host_instance: Option<HostInstanceId> = None;
    let mut revoked_epoch: Option<VaultEpoch> = None;
    let mut revoke: Option<(RequestId, RevokeKeys)> = None;
    let mut replay =
        RequestReplay::new(RequestIdMode::Legacy, "core", None).expect("legacy request ledger");
    while let Some(mut line) = reader.next()? {
        if writer_failed.load(Ordering::Acquire) || client.failed() {
            return Err(invalid_frame());
        }
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let envelope: Envelope<'_> = serde_json::from_slice(&line).map_err(|_| invalid_frame())?;
        if envelope.jsonrpc != "2.0" {
            return Err(invalid_frame());
        }
        if envelope.method.is_none() {
            if !authenticated {
                return Err(invalid_frame());
            }
            client.deliver(&mut line).map_err(|_| invalid_frame())?;
        } else {
            // Only commands/notifications take this generic path. Reverse key
            // results were borrowed raw and routed above, never via RpcMessage.
            let message: RpcMessage = serde_json::from_slice(&line).map_err(|_| invalid_frame())?;
            if let RpcMessage::Request(request) = &message
                && authenticated
                && request.method != "plugin/handshake"
            {
                match replay.accept(&request.id) {
                    Ok(()) => (),
                    Err(ReplayError::Full) => return Err(invalid_frame()),
                    Err(error) => {
                        send_error(
                            &client,
                            request.id.clone(),
                            if error == ReplayError::Duplicate {
                                ErrorCode::DuplicateRequest
                            } else {
                                ErrorCode::InvalidRequest
                            },
                        )?;
                        continue;
                    }
                }
            }
            match message {
                RpcMessage::Notification(notification)
                    if notification.method == Heartbeat::METHOD && authenticated =>
                {
                    let heartbeat: Heartbeat =
                        serde_json::from_value(notification.params.ok_or_else(invalid_frame)?)
                            .map_err(|_| invalid_frame())?;
                    send(&client, RpcMessage::Notification(heartbeat.notification()))?;
                }
                RpcMessage::Notification(notification)
                    if notification.method == CancelRequest::METHOD && authenticated =>
                {
                    let cancel: CancelRequest =
                        serde_json::from_value(notification.params.ok_or_else(invalid_frame)?)
                            .map_err(|_| invalid_frame())?;
                    if let Some(operation) = active
                        .lock()
                        .expect("SDK active poisoned")
                        .get(&cancel.request_id)
                    {
                        operation.cancel();
                    }
                }
                RpcMessage::Request(request) if request.method == "plugin/handshake" => {
                    let accepted = if authenticated {
                        Err(RpcError::from_code(ErrorCode::InvalidState))
                    } else {
                        handshake(&request, &config, &token, storage.as_deref())
                    };
                    let response = match accepted {
                        Ok((response, instance)) => {
                            replay = RequestReplay::new(
                                response.request_id_mode,
                                "core",
                                instance.as_ref(),
                            )
                            .map_err(|_| invalid_frame())?;
                            authenticated = true;
                            scoped_commands = !response.core_services.is_empty();
                            host_instance = instance;
                            RpcResponse::success(
                                request.id,
                                serde_json::to_value(response).expect("handshake serializable"),
                            )
                        }
                        Err(error) => RpcResponse::failure(Some(request.id), error),
                    };
                    send(&client, RpcMessage::Response(response))?;
                }
                RpcMessage::Request(request)
                    if authenticated && request.method == VAULT_REVOKE_METHOD =>
                {
                    let params = request
                        .params
                        .and_then(|params| serde_json::from_value::<RevokeKeys>(params).ok());
                    match params {
                        Some(params)
                            if Some(&params.host_instance) == host_instance.as_ref()
                                && storage.as_ref().is_none_or(|storage| {
                                    params.profile_generation == storage.context().generation
                                })
                                && revoke.is_none()
                                && revoked_epoch
                                    .is_none_or(|epoch| params.vault_epoch.get() > epoch.get()) =>
                        {
                            for operation in active.lock().expect("SDK active poisoned").values() {
                                operation.cancel();
                            }
                            revoked_epoch = Some(params.vault_epoch);
                            revoke = Some((request.id, params));
                        }
                        _ => send_error(&client, request.id, ErrorCode::InvalidParams)?,
                    }
                }
                RpcMessage::Request(request) if authenticated => {
                    if let Some(error) = validate_command(
                        &request,
                        &config,
                        scoped_commands,
                        host_instance.as_ref(),
                        revoked_epoch,
                        revoke.is_some(),
                        storage.as_ref().map(|storage| storage.context()),
                    ) {
                        send(
                            &client,
                            RpcMessage::Response(RpcResponse::failure(Some(request.id), error)),
                        )?;
                        continue;
                    }
                    let mut running = active.lock().expect("SDK active poisoned");
                    if !running.is_empty() {
                        send_error(&client, request.id, ErrorCode::InvalidState)?;
                        continue;
                    }
                    let operation = Arc::new(Operation::new(
                        request.context.clone(),
                        std::time::Instant::now()
                            + if crate::snapshot::is_snapshot(&request.method) {
                                config.snapshot_timeout.min(Duration::from_secs(300))
                            } else {
                                config.operation_timeout
                            },
                        client.clone(),
                    ));
                    running.insert(request.id.clone(), operation.clone());
                    let id = request.id.clone();
                    if jobs
                        .try_send(worker::Job {
                            request,
                            operation,
                            host: host_instance.clone(),
                        })
                        .is_err()
                    {
                        running.remove(&id);
                        send_error(&client, id, ErrorCode::InvalidState)?;
                    }
                }
                RpcMessage::Request(request) => {
                    send_error(&client, request.id, ErrorCode::InvalidState)?
                }
                _ => return Err(invalid_frame()),
            }
        }
        if revoke.is_some() && active.lock().expect("SDK active poisoned").is_empty() {
            let (id, params) = revoke.take().expect("pending revoke");
            let reply = RevokedKeys {
                host_instance: params.host_instance,
                profile_generation: params.profile_generation,
                vault_epoch: params.vault_epoch,
            };
            send(
                &client,
                RpcMessage::Response(RpcResponse::success(
                    id,
                    serde_json::to_value(reply).expect("revoke serializable"),
                )),
            )?;
        }
    }
    Ok(())
}

pub(crate) fn handshake(
    request: &RpcRequest,
    config: &HostConfig,
    token: &str,
    storage: Option<&HostStorage>,
) -> Result<(HandshakeResponse, Option<HostInstanceId>), RpcError> {
    let handshake: HandshakeRequest =
        serde_json::from_value(request.params.clone().unwrap_or_default())
            .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
    validate_versions(handshake.api_version, handshake.protocol_version)?;
    validate_token(token, &handshake.token)?;
    let profile = confirm_profile_handshake(storage, handshake.profile.as_ref())?;
    let mut services = config.required_services.clone();
    for (name, version) in &config.optional_services.0 {
        if handshake.core_services.supports(name, *version) {
            services.0.insert(name.clone(), *version);
        }
    }
    if handshake.plugin_id != config.plugin_id
        || handshake.plugin_version != config.plugin_version
        || handshake.commands.iter().cloned().collect::<BTreeSet<_>>() != config.commands
        || handshake
            .permissions
            .iter()
            .cloned()
            .collect::<BTreeSet<_>>()
            != config.permissions
        || config
            .required_services
            .0
            .iter()
            .any(|(name, version)| !handshake.core_services.supports(name, *version))
        || (!services.is_empty() && handshake.host_instance.is_none())
        || (handshake.request_id_mode == RequestIdMode::MonotonicV1
            && handshake.host_instance.is_none())
    {
        return Err(RpcError::from_code(ErrorCode::PermissionDenied));
    }
    let mut response = HandshakeResponse::accepted(1000);
    response.core_services = services;
    response.profile = profile;
    response.request_id_mode = handshake.request_id_mode;
    Ok((response, handshake.host_instance))
}

fn validate_command(
    request: &RpcRequest,
    config: &HostConfig,
    scoped_commands: bool,
    host: Option<&HostInstanceId>,
    revoked: Option<VaultEpoch>,
    revoking: bool,
    profile: Option<&taomni_plugin_api::services::HostProfileContext>,
) -> Option<RpcError> {
    if !config.commands.contains(&request.method) {
        return Some(RpcError::from_code(ErrorCode::MethodNotFound));
    }
    if revoking {
        return Some(RpcError::from_code(ErrorCode::InvalidState));
    }
    if crate::snapshot::is_snapshot(&request.method) {
        return (profile.is_none() || host.is_none() || request.context.is_some())
            .then(|| RpcError::from_code(ErrorCode::PermissionDenied));
    }
    if scoped_commands {
        let valid = request.context.as_ref().is_some_and(|context| Some(&context.host_instance) == host
            && revoked.is_none_or(|epoch| context.vault_epoch.get() > epoch.get())
            && profile.is_none_or(|profile| profile.generation == context.profile_generation)
            && matches!(&request.id, RequestId::String(id) if id.starts_with(&format!("core/{}/", context.host_instance))));
        if !valid {
            return Some(RpcError::from_code(ErrorCode::InvalidState));
        }
    }
    None
}

fn send(client: &ServiceClient, message: RpcMessage) -> io::Result<()> {
    client.send(message).map_err(|_| invalid_frame())
}
fn send_error(client: &ServiceClient, id: RequestId, code: ErrorCode) -> io::Result<()> {
    send(
        client,
        RpcMessage::Response(RpcResponse::failure(Some(id), RpcError::from_code(code))),
    )
}

struct CancelOnExit(ActiveOperations);
impl Drop for CancelOnExit {
    fn drop(&mut self) {
        for operation in self.0.lock().expect("SDK active poisoned").values() {
            operation.cancel();
        }
    }
}
