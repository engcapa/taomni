//! Windows transparent capture via WinDivert (plan §4.1/§8, ADR-0002).
//!
//! Windows offers no driver-free capture path, so this backend uses WinDivert
//! (a signed kernel driver + DLL). It performs NETWORK-layer NAT: an outbound
//! TCP SYN's destination is redirected to the local transparent port, the
//! original destination is remembered in a connection-tracking map keyed by the
//! app's ephemeral source port, and return packets from the local port have
//! their source rewritten back so the app is none the wiser. All header/checksum
//! work uses the unit-tested pure helpers in `packet.rs`.
//!
//! This module is `#[cfg(all(windows, feature = "sockscap-windivert"))]`: it is
//! NOT built by the default profile, because it links `WinDivert` and requires
//! the SDK at build time and the signed driver at runtime — external artifacts
//! that a code-only environment cannot provide. It has therefore not been
//! compiled or run here; it is written faithfully to the WinDivert 2.x C ABI
//! for a WinDivert-equipped build to compile and validate.

// Feature-gated FFI: some WINDIVERT_ADDRESS fields are ABI padding we never
// read, and helper accessors exist for completeness.
#![allow(non_snake_case, non_camel_case_types, dead_code)]

use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::os::raw::{c_char, c_void};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use super::packet;

// WinDivert layers / flags (from windivert.h).
const WINDIVERT_LAYER_NETWORK: i32 = 0;
type HANDLE = *mut c_void;
const INVALID_HANDLE_VALUE: isize = -1;

/// WINDIVERT_ADDRESS (80 bytes). We treat the trailing union opaquely and only
/// touch the flags word to read/flip the Outbound bit for reinjection.
#[repr(C)]
#[derive(Clone, Copy)]
struct WinDivertAddress {
    timestamp: i64,
    /// Layer:8, Event:8, Sniffed:1, Outbound:1, Loopback:1, Impostor:1, … .
    flags: u32,
    reserved2: u32,
    union: [u8; 64],
}

impl WinDivertAddress {
    fn zeroed() -> WinDivertAddress {
        WinDivertAddress {
            timestamp: 0,
            flags: 0,
            reserved2: 0,
            union: [0u8; 64],
        }
    }
    fn is_outbound(&self) -> bool {
        (self.flags & (1 << 17)) != 0
    }
}

#[link(name = "WinDivert")]
unsafe extern "C" {
    fn WinDivertOpen(filter: *const c_char, layer: i32, priority: i16, flags: u64) -> HANDLE;
    fn WinDivertRecv(
        handle: HANDLE,
        pPacket: *mut c_void,
        packetLen: u32,
        pRecvLen: *mut u32,
        pAddr: *mut WinDivertAddress,
    ) -> i32;
    fn WinDivertSend(
        handle: HANDLE,
        pPacket: *const c_void,
        packetLen: u32,
        pSendLen: *mut u32,
        pAddr: *const WinDivertAddress,
    ) -> i32;
    fn WinDivertClose(handle: HANDLE) -> i32;
}

/// The original destination of a redirected flow, keyed by the app's source
/// port so the local transparent listener can recover it (Windows has no
/// SO_ORIGINAL_DST).
pub type ConnTrack = Arc<Mutex<HashMap<u16, (Ipv4Addr, u16)>>>;

/// A running WinDivert NAT engine.
pub struct WinDivertEngine {
    handle: HANDLE,
    running: Arc<AtomicBool>,
    pub conntrack: ConnTrack,
    local_port: u16,
}

// The raw handle is only used from the single capture thread.
unsafe impl Send for WinDivertEngine {}

impl WinDivertEngine {
    /// Open a WinDivert NETWORK handle capturing outbound app TCP and inbound
    /// loopback responses for the transparent port.
    pub fn open(local_port: u16) -> Result<WinDivertEngine, String> {
        // Outbound app traffic (not loopback, not our own port) OR responses
        // coming back from the local transparent port on loopback.
        let filter = format!(
            "tcp and ((outbound and remoteAddr != 127.0.0.1 and tcp.DstPort != {port}) or \
             (loopback and tcp.SrcPort == {port}))\0",
            port = local_port
        );
        let handle = unsafe {
            WinDivertOpen(filter.as_ptr() as *const c_char, WINDIVERT_LAYER_NETWORK, 0, 0)
        };
        if handle as isize == INVALID_HANDLE_VALUE || handle.is_null() {
            return Err("WinDivertOpen failed (driver installed? admin?)".into());
        }
        Ok(WinDivertEngine {
            handle,
            running: Arc::new(AtomicBool::new(true)),
            conntrack: Arc::new(Mutex::new(HashMap::new())),
            local_port,
        })
    }

    pub fn stop_flag(&self) -> Arc<AtomicBool> {
        self.running.clone()
    }

    /// The recv → NAT → send loop. Runs on its own thread until stopped.
    pub fn run(&self) {
        let mut buf = vec![0u8; 65535];
        let mut addr = WinDivertAddress::zeroed();
        while self.running.load(Ordering::Relaxed) {
            let mut recv_len: u32 = 0;
            let ok = unsafe {
                WinDivertRecv(
                    self.handle,
                    buf.as_mut_ptr() as *mut c_void,
                    buf.len() as u32,
                    &mut recv_len,
                    &mut addr,
                )
            };
            if ok == 0 {
                continue;
            }
            let pkt = &mut buf[..recv_len as usize];
            if addr.is_outbound() {
                self.nat_forward(pkt);
            } else {
                self.nat_reverse(pkt);
            }
            let mut send_len: u32 = 0;
            unsafe {
                WinDivertSend(
                    self.handle,
                    pkt.as_ptr() as *const c_void,
                    recv_len,
                    &mut send_len,
                    &addr,
                );
            }
        }
        unsafe {
            WinDivertClose(self.handle);
        }
    }

    /// Outbound: record original dst by source port, redirect dst → local port.
    fn nat_forward(&self, pkt: &mut [u8]) {
        let (Some(dst), Some(dport)) = (packet::ipv4_dst(pkt), packet::tcp_dst_port(pkt)) else {
            return;
        };
        if let Some(ihl) = packet::ipv4_header_len(pkt) {
            let sport = u16::from_be_bytes([pkt[ihl], pkt[ihl + 1]]);
            self.conntrack.lock().unwrap().insert(sport, (dst, dport));
        }
        let _ = packet::redirect_ipv4_tcp(pkt, Ipv4Addr::LOCALHOST, self.local_port);
    }

    /// Inbound from the local port: rewrite src back to the original dst so the
    /// app accepts the response.
    fn nat_reverse(&self, pkt: &mut [u8]) {
        let Some(ihl) = packet::ipv4_header_len(pkt) else {
            return;
        };
        if pkt.len() < ihl + 4 {
            return;
        }
        let dport = u16::from_be_bytes([pkt[ihl + 2], pkt[ihl + 3]]);
        if let Some((orig_ip, orig_port)) = self.conntrack.lock().unwrap().get(&dport).copied() {
            // Rewrite source address + port to the original destination.
            pkt[12..16].copy_from_slice(&orig_ip.octets());
            pkt[ihl..ihl + 2].copy_from_slice(&orig_port.to_be_bytes());
            let _ = packet::fix_ipv4_checksum(pkt);
            let _ = packet::fix_tcp_checksum(pkt);
        }
    }
}
