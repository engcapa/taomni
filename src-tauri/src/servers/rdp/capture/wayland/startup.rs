use super::lifetime::WaylandCapturer;
use crate::servers::engine::LogEmitter;
use crate::servers::rdp::capture::Capturer;
use anyhow::bail;

/// The environment is authoritative. `DISPLAY` is commonly present in a real
/// Wayland session because XWayland is running, so it must not affect routing.
pub(crate) fn is_wayland_session() -> bool {
    std::env::var_os("WAYLAND_DISPLAY").is_some()
        || std::env::var("XDG_SESSION_TYPE")
            .is_ok_and(|value| value.eq_ignore_ascii_case("wayland"))
}

pub(crate) fn try_new(log: &LogEmitter, request_input: bool) -> anyhow::Result<Box<dyn Capturer>> {
    log.line(
        "Wayland session: requesting one RemoteDesktop portal session for persistent \
         PipeWire capture and optional keyboard/pointer control",
    );
    Ok(Box::new(WaylandCapturer::new(log, request_input, None)?))
}

/// Portal metadata uses compositor logical coordinates, including on mixed-DPI desktops.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct MonitorTarget {
    pub position: (i32, i32),
    pub size: (i32, i32),
    pub single_monitor: bool,
}

pub(crate) fn try_new_for_monitor(
    log: &LogEmitter,
    request_input: bool,
    target: MonitorTarget,
) -> anyhow::Result<Box<dyn Capturer>> {
    Ok(Box::new(WaylandCapturer::new(
        log,
        request_input,
        Some(target),
    )?))
}

pub(super) fn monitor_stream_index(
    streams: &[(Option<(i32, i32)>, Option<(i32, i32)>)],
    target: MonitorTarget,
) -> anyhow::Result<usize> {
    let matches: Vec<_> = streams
        .iter()
        .enumerate()
        .filter_map(|(index, (position, size))| {
            (*position == Some(target.position) && *size == Some(target.size)).then_some(index)
        })
        .collect();
    if matches.len() == 1 {
        return Ok(matches[0]);
    }
    // Metadata is optional in the portal protocol. A unique stream is safe
    // only when the OS itself reports one monitor, never on a dual desktop.
    if target.single_monitor
        && streams.len() == 1
        && streams[0].0.is_none_or(|p| p == target.position)
        && streams[0].1.is_none_or(|s| s == target.size)
    {
        return Ok(0);
    }
    bail!(
        "The screen-sharing portal did not identify the selected monitor at {:?} ({:?}). Share the selected screen or all screens and retry. Returned streams: {streams:?}",
        target.position,
        target.size
    )
}
