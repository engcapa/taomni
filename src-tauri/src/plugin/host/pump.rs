//! One bidirectional pump for active calls, idle supervision and cancellation.
//! Service work runs on independent bounded workers, never under this mutex.

use super::*;
use std::sync::mpsc::{RecvTimeoutError, TryRecvError};

pub(super) enum PumpOutcome {
    Idle,
    Handled,
    Response(RpcResponse),
}

impl HostProcess {
    pub(super) fn receive_response(
        &mut self,
        id: &RequestId,
        deadline: Instant,
        check_cancel: bool,
    ) -> Result<RpcResponse, HostProcessError> {
        loop {
            if check_cancel {
                if self.cancellation.is_cancelled(id) {
                    return Err(HostProcessError::Cancelled);
                }
                if let Some(permit) = &self.active_operation {
                    permit.check_current().map_err(service_error)?;
                }
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(HostProcessError::Timeout);
            }
            self.send_heartbeat()?;
            if check_cancel {
                for event in self.supervisor.poll(self.elapsed_ms()) {
                    match event {
                        SupervisorEvent::RequestTimeout(_) => {
                            return Err(HostProcessError::Timeout);
                        }
                        SupervisorEvent::HeartbeatTimeout { .. } => {
                            return Err(HostProcessError::Crashed);
                        }
                    }
                }
            }
            match self.pump_one(Some(remaining.min(Duration::from_millis(20))), Some(id))? {
                PumpOutcome::Response(response) => return Ok(response),
                PumpOutcome::Idle | PumpOutcome::Handled => {}
            }
        }
    }

    pub(super) fn pump_one(
        &mut self,
        wait: Option<Duration>,
        expected: Option<&RequestId>,
    ) -> Result<PumpOutcome, HostProcessError> {
        self.flush_service_completions()?;
        let transport = self.transport.as_ref().ok_or(HostProcessError::Crashed)?;
        let message = match wait {
            Some(wait) => match transport.reader.recv_timeout(wait) {
                Ok(message) => message?,
                Err(RecvTimeoutError::Timeout) => return Ok(PumpOutcome::Idle),
                Err(RecvTimeoutError::Disconnected) => return Err(HostProcessError::Crashed),
            },
            None => match transport.reader.try_recv() {
                Ok(message) => message?,
                Err(TryRecvError::Empty) => return Ok(PumpOutcome::Idle),
                Err(TryRecvError::Disconnected) => return Err(HostProcessError::Crashed),
            },
        };
        match message {
            RpcMessage::Response(response)
                if response.jsonrpc == "2.0"
                    && response.id.as_ref() == expected
                    && expected.is_some()
                    && (response.result.is_some() != response.error.is_some()) =>
            {
                Ok(PumpOutcome::Response(response))
            }
            RpcMessage::Response(_) => Err(HostProcessError::UnexpectedResponse),
            RpcMessage::Request(request) => {
                if expected == Some(&request.id) {
                    return Err(HostProcessError::UnexpectedResponse);
                }
                let id = request.id.clone();
                let result = if self.supervisor.state() != HostState::Running {
                    Err(RpcError::new(
                        ErrorCode::InvalidState,
                        "CORE_SERVICE_HANDSHAKE_REQUIRED",
                    ))
                } else if let Some(session) = &mut self.services {
                    session.submit(request)
                } else {
                    Err(RpcError::from_code(ErrorCode::MethodNotFound))
                };
                if let Err(error) = result {
                    self.transport
                        .as_ref()
                        .ok_or(HostProcessError::Crashed)?
                        .notify(&RpcMessage::Response(RpcResponse::failure(Some(id), error)))?;
                }
                Ok(PumpOutcome::Handled)
            }
            RpcMessage::Notification(notification) => {
                if notification.jsonrpc != "2.0" {
                    return Err(HostProcessError::UnexpectedResponse);
                }
                match notification.method.as_str() {
                    Heartbeat::METHOD => {
                        let heartbeat = notification
                            .params
                            .and_then(|params| serde_json::from_value::<Heartbeat>(params).ok())
                            .ok_or(HostProcessError::UnexpectedResponse)?;
                        self.supervisor
                            .record_heartbeat(&heartbeat, self.elapsed_ms());
                    }
                    taomni_plugin_api::PluginEvent::METHOD => {}
                    _ => return Err(HostProcessError::UnexpectedResponse),
                }
                Ok(PumpOutcome::Handled)
            }
        }
    }

    fn flush_service_completions(&mut self) -> Result<(), HostProcessError> {
        let Some(session) = &mut self.services else {
            return Ok(());
        };
        for _ in 0..8 {
            let Some(completion) = session.try_completion().map_err(service_error)? else {
                break;
            };
            let transport = self.transport.as_ref().ok_or(HostProcessError::Crashed)?;
            match completion.result {
                Ok(frame) => transport.service_reply(frame)?,
                Err(error) => transport.notify(&RpcMessage::Response(RpcResponse::failure(
                    Some(completion.id),
                    error,
                )))?,
            }
        }
        Ok(())
    }

    pub(super) fn send_heartbeat(&mut self) -> Result<(), HostProcessError> {
        let now_ms = self.elapsed_ms();
        if now_ms < self.next_heartbeat_ms || self.supervisor.state() != HostState::Running {
            return Ok(());
        }
        self.transport
            .as_ref()
            .ok_or(HostProcessError::Crashed)?
            .notify(&RpcMessage::Notification(
                Heartbeat {
                    timestamp_ms: now_ms,
                }
                .notification(),
            ))?;
        let interval =
            (self.supervisor.config().heartbeat_timeout.as_millis() / 3).clamp(1, 1_000) as u64;
        self.next_heartbeat_ms = now_ms.saturating_add(interval);
        Ok(())
    }

    pub(super) fn cancel_in_host(&mut self, id: &RequestId, reason: &str) {
        if let Some(permit) = &self.active_operation {
            permit.cancel();
        }
        self.supervisor.cancel_request(id, Some(reason.into()));
        let notification = CancelRequest {
            request_id: id.clone(),
            reason: Some(reason.into()),
        }
        .notification();
        let sent = self.transport.as_ref().is_some_and(|transport| {
            transport
                .notify(&RpcMessage::Notification(notification))
                .is_ok()
        });
        let acknowledged = sent
            && self
                .receive_response(id, Instant::now() + Duration::from_millis(100), false)
                .is_ok_and(|reply| {
                    self.active_operation.is_none()
                        || reply
                            .error
                            .is_some_and(|error| error.code == ErrorCode::RequestCancelled.as_i32())
                });
        if !acknowledged {
            self.schedule_restart();
        }
    }
}
