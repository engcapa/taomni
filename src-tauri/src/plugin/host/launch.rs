//! A host becomes usable only after authenticated handshake and its declared
//! activation hook have completed. Replacements follow the same path; requests
//! from the previous process are never replayed.
use super::profile::validate_profile_ack;
use super::service_requests::fresh_host_instance;
use super::{HostProcess, HostProcessError, Transport, process_token};
use std::{process::Command, time::Instant};
use taomni_plugin_api::{
    HandshakeRequest, HandshakeResponse, RequestIdMode, RpcError, RpcMessage, RpcRequest,
    validate_versions,
};
use taomni_plugin_services::ServiceSession;

impl HostProcess {
    pub(super) fn spawn_and_activate(&mut self) -> Result<(), HostProcessError> {
        let deadline = Instant::now() + self.supervisor.config().request_timeout;
        self.spawn_and_handshake(deadline)?;
        // Lifecycle hooks are optional in protocol v1. Never send a hook that
        // is absent from the authenticated manifest (e.g. a service-only host).
        if self
            .launch
            .commands
            .iter()
            .any(|method| method == "plugin/enable")
        {
            let id = self.next_request_id()?;
            self.invoke_until(id, "plugin/enable", None, Some(deadline))?;
        }
        Ok(())
    }

    fn spawn_and_handshake(&mut self, deadline: Instant) -> Result<(), HostProcessError> {
        self.discard_services();
        super::execution::check(&self.launch.host)?;
        self.token = process_token();
        let mut command = Command::new(&self.launch.host);
        command
            .current_dir(&self.launch.working_dir)
            .env("TAOMNI_PLUGIN_TOKEN", &self.token)
            .env_remove(taomni_plugin_api::services::HOST_PROFILE_ENV);
        if self.launch.plugin_id == "taomni-plugin-vnc-client" {
            command.env("TAOMNI_VNC_DESKTOP_PID", std::process::id().to_string());
        }
        if let Some(profile) = &self.launch.profile {
            profile.configure(&mut command, &self.launch.plugin_id)?;
        }
        self.transport = Some(Transport::spawn(command)?);
        let mut request = HandshakeRequest::new(
            &self.launch.plugin_id,
            &self.launch.plugin_version,
            &self.token,
            self.launch.commands.clone(),
            self.launch.permissions.clone(),
        );
        request.profile = self
            .launch
            .profile
            .as_ref()
            .map(|profile| profile.context().clone());
        if let Some(services) = &self.service_config {
            request.core_services = services.grants.service_capabilities();
        }
        request.host_instance = Some(fresh_host_instance());
        request.request_id_mode = RequestIdMode::MonotonicV1;
        let id = self.next_request_id()?;
        let message = RpcMessage::Request(RpcRequest::new(
            id.clone(),
            "plugin/handshake",
            Some(serde_json::to_value(&request).expect("serializable handshake")),
        ));
        self.transport
            .as_ref()
            .expect("spawned transport")
            .write(&message, deadline, None)?;
        let response = self.receive_response(&id, deadline, false)?;
        let value = response
            .result
            .ok_or_else(|| response_error(response.error))?;
        let handshake: HandshakeResponse = serde_json::from_value(value)
            .map_err(|error| HostProcessError::Handshake(error.to_string()))?;
        validate_versions(handshake.api_version, handshake.protocol_version)
            .map_err(|error| HostProcessError::Handshake(error.message))?;
        if !handshake.accepted {
            return Err(HostProcessError::Handshake(
                handshake
                    .error
                    .map(|error| error.message)
                    .unwrap_or_else(|| "host rejected handshake".into()),
            ));
        }
        validate_profile_ack(request.profile.as_ref(), handshake.profile.as_ref())?;
        // Missing echo is an old peer. Never infer support from ID shape.
        if handshake.request_id_mode != RequestIdMode::Legacy
            && handshake.request_id_mode != request.request_id_mode
        {
            return Err(HostProcessError::Handshake(
                "request ID mode was not offered".into(),
            ));
        }
        if request
            .core_services
            .0
            .iter()
            .any(|(name, version)| !handshake.core_services.supports(name, *version))
        {
            return Err(HostProcessError::Handshake(
                "required core service was not negotiated".into(),
            ));
        }
        let accepted = self
            .supervisor
            .accept_handshake(&request, &self.token, self.elapsed_ms());
        if !accepted.accepted {
            return Err(HostProcessError::Handshake(
                "core rejected handshake".into(),
            ));
        }
        self.instance = request.host_instance.clone();
        self.request_id_mode = handshake.request_id_mode;
        if let Some(config) = &self.service_config {
            let host = config.grants.clone().bind_authenticated_transport(
                request.host_instance.expect("service transport identity"),
            );
            self.transport
                .as_mut()
                .expect("handshaken transport")
                .bind_services(config.dispatcher.clone(), host.clone());
            self.services = Some(ServiceSession::with_request_id_mode(
                config.dispatcher.clone(),
                host,
                self.request_id_mode,
            ));
        }
        self.next_heartbeat_ms = self.elapsed_ms();
        Ok(())
    }
}

fn response_error(error: Option<RpcError>) -> HostProcessError {
    error
        .map(|error| HostProcessError::Rpc {
            code: error.code,
            message: error.message,
        })
        .unwrap_or_else(|| HostProcessError::Handshake("handshake returned no result".into()))
}
