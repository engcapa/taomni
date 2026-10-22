use super::startup::MonitorTarget;
use super::startup::monitor_stream_index;
use crate::servers::rdp::capture::PortalInput;
use anyhow::Context as _;
use anyhow::bail;
use ashpd::desktop::PersistMode;
use ashpd::desktop::Session;
use ashpd::desktop::remote_desktop::Axis as PortalAxis;
use ashpd::desktop::remote_desktop::DeviceType;
use ashpd::desktop::remote_desktop::KeyState;
use ashpd::desktop::remote_desktop::RemoteDesktop;
use ashpd::desktop::screencast::CursorMode;
use ashpd::desktop::screencast::Screencast;
use ashpd::desktop::screencast::SourceType;
use std::os::fd::OwnedFd;

pub(super) struct PortalContext {
    pub(super) runtime: tokio::runtime::Runtime,
    pub(super) remote_desktop: RemoteDesktop<'static>,
    pub(super) screencast: Screencast<'static>,
    pub(super) session: Session<'static, RemoteDesktop<'static>>,
    pub(super) stream_node: u32,
    pub(super) logical_size: Option<(u32, u32)>,
    pub(super) input_enabled: bool,
}

impl PortalContext {
    pub(super) fn new(
        request_input: bool,
        target: Option<MonitorTarget>,
    ) -> anyhow::Result<(Self, OwnedFd)> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .context("create Wayland portal runtime")?;

        let (
            remote_desktop,
            screencast,
            session,
            stream_node,
            logical_size,
            input_enabled,
            pipewire_fd,
        ) = runtime.block_on(async move {
            let remote_desktop = RemoteDesktop::new().await?;
            let screencast = Screencast::new().await?;
            let session = remote_desktop.create_session().await?;

            if request_input {
                remote_desktop
                    .select_devices(
                        &session,
                        DeviceType::Keyboard | DeviceType::Pointer,
                        None,
                        PersistMode::DoNot,
                    )
                    .await?
                    .response()?;
            }
            screencast
                .select_sources(
                    &session,
                    CursorMode::Embedded,
                    SourceType::Monitor.into(),
                    target.is_some(),
                    None,
                    PersistMode::DoNot,
                )
                .await?
                .response()?;

            let response = remote_desktop.start(&session, None).await?.response()?;
            let streams = response
                .streams()
                .filter(|streams| !streams.is_empty())
                .ok_or_else(|| anyhow::anyhow!("portal did not return a monitor stream"))?;
            let index = match target {
                Some(target) => match monitor_stream_index(
                    &streams
                        .iter()
                        .map(|s| (s.position(), s.size()))
                        .collect::<Vec<_>>(),
                    target,
                ) {
                    Ok(index) => index,
                    Err(error) => {
                        let _ = session.close().await;
                        return Err(error);
                    }
                },
                None => 0,
            };
            let stream = &streams[index];
            let logical_size = stream.size().and_then(|(width, height)| {
                u32::try_from(width).ok().zip(u32::try_from(height).ok())
            });
            let input_enabled = request_input
                && response.devices().contains(DeviceType::Keyboard)
                && response.devices().contains(DeviceType::Pointer);
            let stream_node = stream.pipe_wire_node_id();
            let pipewire_fd = screencast.open_pipe_wire_remote(&session).await?;
            Ok::<_, anyhow::Error>((
                remote_desktop,
                screencast,
                session,
                stream_node,
                logical_size,
                input_enabled,
                pipewire_fd,
            ))
        })?;

        Ok((
            Self {
                runtime,
                remote_desktop,
                screencast,
                session,
                stream_node,
                logical_size,
                input_enabled,
            },
            pipewire_fd,
        ))
    }

    pub(super) fn inject(&self, input: PortalInput) -> anyhow::Result<()> {
        if !self.input_enabled {
            bail!("Wayland portal did not grant keyboard and pointer control");
        }
        self.runtime.block_on(async {
            match input {
                PortalInput::Keycode { code, pressed } => {
                    self.remote_desktop
                        .notify_keyboard_keycode(&self.session, code, key_state(pressed))
                        .await?
                }
                PortalInput::Keysym { keysym, pressed } => {
                    self.remote_desktop
                        .notify_keyboard_keysym(&self.session, keysym, key_state(pressed))
                        .await?
                }
                PortalInput::Button { button, pressed } => {
                    self.remote_desktop
                        .notify_pointer_button(&self.session, button, key_state(pressed))
                        .await?
                }
                PortalInput::MotionAbsolute { x, y } => {
                    self.remote_desktop
                        .notify_pointer_motion_absolute(&self.session, self.stream_node, x, y)
                        .await?
                }
                PortalInput::MotionRelative { dx, dy } => {
                    self.remote_desktop
                        .notify_pointer_motion(&self.session, dx, dy)
                        .await?
                }
                PortalInput::Scroll { horizontal, steps } => {
                    let axis = if horizontal {
                        PortalAxis::Horizontal
                    } else {
                        PortalAxis::Vertical
                    };
                    self.remote_desktop
                        .notify_pointer_axis_discrete(&self.session, axis, steps)
                        .await?
                }
            }
            Ok::<_, ashpd::Error>(())
        })?;
        Ok(())
    }
}

impl Drop for PortalContext {
    fn drop(&mut self) {
        let _ = self.runtime.block_on(self.session.close());
        let _ = &self.screencast;
    }
}

pub(super) fn key_state(pressed: bool) -> KeyState {
    if pressed {
        KeyState::Pressed
    } else {
        KeyState::Released
    }
}
