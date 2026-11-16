//! One control-channel pump for active calls, idle supervision and cancellation.

use super::*;
use std::sync::mpsc::RecvTimeoutError;

impl HostProcess {
    pub(super) fn receive_response(
        &mut self,
        id: &RequestId,
        deadline: Instant,
        check_cancel: bool,
    ) -> Result<RpcResponse, HostProcessError> {
        loop {
            if check_cancel && self.cancellation.is_cancelled(id) {
                return Err(HostProcessError::Cancelled);
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(HostProcessError::Timeout);
            }
            if check_cancel {
                self.send_heartbeat()?;
                let now_ms = self.elapsed_ms();
                for event in self.supervisor.poll(now_ms) {
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
            let message = match self
                .transport
                .as_ref()
                .ok_or(HostProcessError::Crashed)?
                .reader
                .recv_timeout(remaining.min(Duration::from_millis(20)))
            {
                Ok(message) => message?,
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => return Err(HostProcessError::Crashed),
            };
            match message {
                RpcMessage::Response(response) if response.id.as_ref() == Some(id) => {
                    return Ok(response);
                }
                other => self.accept_notification(other),
            }
        }
    }

    pub(super) fn accept_notification(&mut self, message: RpcMessage) {
        if let RpcMessage::Notification(notification) = message {
            if notification.method == Heartbeat::METHOD {
                if let Some(heartbeat) = notification
                    .params
                    .and_then(|params| serde_json::from_value::<Heartbeat>(params).ok())
                {
                    self.supervisor
                        .record_heartbeat(&heartbeat, self.elapsed_ms());
                }
            }
        }
    }

    pub(super) fn send_heartbeat(&mut self) -> Result<(), HostProcessError> {
        let now_ms = self.elapsed_ms();
        if now_ms < self.next_heartbeat_ms || self.supervisor.state() != HostState::Running {
            return Ok(());
        }
        let notification = Heartbeat {
            timestamp_ms: now_ms,
        }
        .notification();
        self.transport
            .as_ref()
            .ok_or(HostProcessError::Crashed)?
            .notify(&RpcMessage::Notification(notification))?;
        let interval =
            (self.supervisor.config().heartbeat_timeout.as_millis() / 3).clamp(1, 1_000) as u64;
        self.next_heartbeat_ms = now_ms.saturating_add(interval);
        Ok(())
    }

    pub(super) fn cancel_in_host(&mut self, id: &RequestId, reason: &str) {
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
        // An uncooperative host must not continue an operation after the core
        // has reported cancellation. Give it a bounded chance to acknowledge,
        // then terminate the process tree and let the monitor restart it.
        if !sent
            || self
                .receive_response(id, Instant::now() + Duration::from_millis(100), false)
                .is_err()
        {
            self.schedule_restart();
        }
    }
}
