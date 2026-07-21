//! Dynamic WinDivert FFI (load DLL at runtime — LGPLv3/GPLv2 isolation).

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::ptr;

use winapi::shared::minwindef::{FARPROC, HMODULE};
use winapi::um::libloaderapi::{FreeLibrary, GetProcAddress, LoadLibraryW};
use winapi::um::winnt::HANDLE;

pub const LAYER_NETWORK: i32 = 0;
pub const LAYER_FLOW: i32 = 2;
pub const LAYER_SOCKET: i32 = 3;

pub const WINDIVERT_HELPER_NO_IP_CHECKSUM: u64 = 1;
pub const WINDIVERT_HELPER_NO_TCP_CHECKSUM: u64 = 2;

type OpenFn = unsafe extern "C" fn(*const i8, i32, i16, u64) -> HANDLE;
type RecvFn = unsafe extern "C" fn(HANDLE, *mut u8, u32, *mut u32, *mut u8) -> i32;
type SendFn = unsafe extern "C" fn(HANDLE, *const u8, u32, *mut u32, *const u8) -> i32;
type CloseFn = unsafe extern "C" fn(HANDLE) -> i32;
type CalcChecksumsFn = unsafe extern "C" fn(*mut u8, u32, *mut u8, u64) -> i32;
type ShutdownFn = unsafe extern "C" fn(HANDLE, i32) -> i32;

pub struct WinDivertApi {
    module: HMODULE,
    open: OpenFn,
    recv: RecvFn,
    send: SendFn,
    close: CloseFn,
    calc_checksums: CalcChecksumsFn,
    shutdown: Option<ShutdownFn>,
}

// SAFETY: WinDivert handles are used from dedicated threads with external sync.
unsafe impl Send for WinDivertApi {}
unsafe impl Sync for WinDivertApi {}

impl WinDivertApi {
    pub fn load(dir: Option<&Path>) -> Result<Self, String> {
        let dll = resolve_dll(dir)?;
        let wide: Vec<u16> = OsStr::new(&dll)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let module = unsafe { LoadLibraryW(wide.as_ptr()) };
        if module.is_null() {
            return Err(format!(
                "LoadLibrary({}) failed: {}",
                dll.display(),
                std::io::Error::last_os_error()
            ));
        }
        unsafe {
            let open = load_sym(module, b"WinDivertOpen\0")?;
            let recv = load_sym(module, b"WinDivertRecv\0")?;
            let send = load_sym(module, b"WinDivertSend\0")?;
            let close = load_sym(module, b"WinDivertClose\0")?;
            let calc = load_sym(module, b"WinDivertHelperCalcChecksums\0")?;
            let shutdown = GetProcAddress(module, b"WinDivertShutdown\0".as_ptr() as *const i8);
            Ok(Self {
                module,
                open: std::mem::transmute::<FARPROC, OpenFn>(open),
                recv: std::mem::transmute::<FARPROC, RecvFn>(recv),
                send: std::mem::transmute::<FARPROC, SendFn>(send),
                close: std::mem::transmute::<FARPROC, CloseFn>(close),
                calc_checksums: std::mem::transmute::<FARPROC, CalcChecksumsFn>(calc),
                shutdown: if shutdown.is_null() {
                    None
                } else {
                    Some(std::mem::transmute::<FARPROC, ShutdownFn>(shutdown))
                },
            })
        }
    }

    pub fn open(&self, filter: &str, layer: i32, priority: i16, flags: u64) -> Result<HANDLE, String> {
        let c = std::ffi::CString::new(filter).map_err(|e| e.to_string())?;
        let h = unsafe { (self.open)(c.as_ptr(), layer, priority, flags) };
        if h.is_null() || h == (-1isize as HANDLE) {
            let err = std::io::Error::last_os_error();
            let layer_name = match layer {
                0 => "NETWORK",
                1 => "NETWORK_FORWARD",
                2 => "FLOW",
                3 => "SOCKET",
                4 => "REFLECT",
                _ => "?",
            };
            return Err(format!(
                "WinDivertOpen(layer={layer}/{layer_name}, filter={filter:?}, prio={priority}) failed: {err}"
            ));
        }
        Ok(h)
    }

    pub fn recv(
        &self,
        handle: HANDLE,
        packet: &mut [u8],
        addr: &mut [u8],
    ) -> Result<usize, String> {
        let mut recv_len: u32 = 0;
        let ok = unsafe {
            (self.recv)(
                handle,
                packet.as_mut_ptr(),
                packet.len() as u32,
                &mut recv_len,
                addr.as_mut_ptr(),
            )
        };
        if ok == 0 {
            return Err(format!(
                "WinDivertRecv failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(recv_len as usize)
    }

    pub fn send(&self, handle: HANDLE, packet: &[u8], addr: &[u8]) -> Result<(), String> {
        let mut send_len: u32 = 0;
        let ok = unsafe {
            (self.send)(
                handle,
                packet.as_ptr(),
                packet.len() as u32,
                &mut send_len,
                addr.as_ptr(),
            )
        };
        if ok == 0 {
            return Err(format!(
                "WinDivertSend failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }

    pub fn calc_checksums(&self, packet: &mut [u8], addr: &mut [u8]) {
        unsafe {
            (self.calc_checksums)(
                packet.as_mut_ptr(),
                packet.len() as u32,
                addr.as_mut_ptr(),
                0,
            );
        }
    }

    pub fn close_handle(&self, handle: HANDLE) {
        unsafe {
            if let Some(sd) = self.shutdown {
                let _ = sd(handle, 0 /* both */);
            }
            let _ = (self.close)(handle);
        }
    }
}

impl Drop for WinDivertApi {
    fn drop(&mut self) {
        if !self.module.is_null() {
            unsafe {
                FreeLibrary(self.module);
            }
            self.module = ptr::null_mut();
        }
    }
}

unsafe fn load_sym(module: HMODULE, name: &[u8]) -> Result<FARPROC, String> {
    let p = GetProcAddress(module, name.as_ptr() as *const i8);
    if p.is_null() {
        Err(format!(
            "GetProcAddress({}) failed",
            String::from_utf8_lossy(name)
        ))
    } else {
        Ok(p)
    }
}

fn resolve_dll(dir: Option<&Path>) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Some(d) = dir {
        candidates.push(d.join("WinDivert.dll"));
        candidates.push(d.join("x64").join("WinDivert.dll"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join("WinDivert.dll"));
            candidates.push(parent.join("sockscap").join("windows").join("WinDivert.dll"));
        }
    }
    if let Ok(d) = std::env::var("SOCKSCAP_WINDIVERT_DIR") {
        candidates.push(PathBuf::from(d).join("WinDivert.dll"));
    }
    for c in &candidates {
        if c.is_file() {
            return Ok(c.clone());
        }
    }
    // Let the loader search PATH / SxS.
    Ok(PathBuf::from("WinDivert.dll"))
}

/// WinDivert ADDRESS is a packed bitfield struct; we treat it as opaque bytes.
/// Layout (WinDivert 2.2, MSVC x64) — first 16 bytes:
///   Timestamp: i64
///   Layer: u8, Event: u8, Flags: u16 (bitfields packed), Reserved2: u32
/// Then union (~64 bytes). Total we allocate 128.
pub const ADDR_LEN: usize = 128;

pub fn addr_layer(addr: &[u8]) -> u8 {
    if addr.len() < 9 {
        return 0;
    }
    addr[8]
}

pub fn addr_event(addr: &[u8]) -> u8 {
    if addr.len() < 10 {
        return 0;
    }
    addr[9]
}

/// Flag bits in the UINT32 after Timestamp (offset 8), packed by MSVC as:
/// Layer:8, Event:8, Sniffed:1, Outbound:1, Loopback:1, Impostor:1, IPv6:1, ...
/// So byte at offset 10 holds: Sniffed(0x01) Outbound(0x02) Loopback(0x04) Impostor(0x08) IPv6(0x10)...
const FLAG_SNIFFED: u8 = 0x01;
const FLAG_OUTBOUND: u8 = 0x02;
const FLAG_LOOPBACK: u8 = 0x04;
const FLAG_IMPOSTOR: u8 = 0x08;

pub fn addr_is_outbound(addr: &[u8]) -> bool {
    if addr.len() < 11 {
        return false;
    }
    (addr[10] & FLAG_OUTBOUND) != 0
}

pub fn addr_set_outbound(addr: &mut [u8], on: bool) {
    if addr.len() < 11 {
        return;
    }
    if on {
        addr[10] |= FLAG_OUTBOUND;
    } else {
        addr[10] &= !FLAG_OUTBOUND;
    }
}

pub fn addr_set_loopback(addr: &mut [u8], on: bool) {
    if addr.len() < 11 {
        return;
    }
    if on {
        addr[10] |= FLAG_LOOPBACK;
    } else {
        addr[10] &= !FLAG_LOOPBACK;
    }
}

pub fn addr_set_impostor(addr: &mut [u8], on: bool) {
    if addr.len() < 11 {
        return;
    }
    if on {
        addr[10] |= FLAG_IMPOSTOR;
    } else {
        addr[10] &= !FLAG_IMPOSTOR;
    }
}

/// Prepare address for reinjecting a packet we rewrote toward the local relay.
pub fn addr_for_local_redirect(addr: &mut [u8]) {
    addr_set_outbound(addr, false);
    addr_set_loopback(addr, true);
    addr_set_impostor(addr, true);
    let _ = FLAG_SNIFFED;
}

/// Prepare address for reinjecting a return packet (relay → app) with forged source.
pub fn addr_for_return_to_app(addr: &mut [u8]) {
    addr_set_outbound(addr, false);
    addr_set_loopback(addr, false);
    addr_set_impostor(addr, true);
}

/// FLOW data starts at offset 16 in ADDRESS (after Timestamp+flags header).
/// WINDIVERT_DATA_FLOW:
///   EndpointId u64, ParentEndpointId u64, ProcessId u32,
///   LocalAddr[4] u32, RemoteAddr[4] u32, LocalPort u16, RemotePort u16, Protocol u8
pub fn flow_process_id(addr: &[u8]) -> u32 {
    if addr.len() < 16 + 8 + 8 + 4 {
        return 0;
    }
    let base = 16 + 16; // skip two u64 endpoint ids
    u32::from_le_bytes(addr[base..base + 4].try_into().unwrap_or([0; 4]))
}

/// Parse FLOW local/remote as IpAddr (IPv4 or IPv6).
pub fn flow_endpoints_ip(
    addr: &[u8],
) -> Option<(std::net::IpAddr, u16, std::net::IpAddr, u16, u8)> {
    if addr.len() < 16 + 8 + 8 + 4 + 16 + 16 + 2 + 2 + 1 {
        return None;
    }
    let mut o = 16 + 16 + 4; // after endpoints + pid
    let local = decode_addr128(&addr[o..o + 16]);
    o += 16;
    let remote = decode_addr128(&addr[o..o + 16]);
    o += 16;
    let local_port = u16::from_le_bytes([addr[o], addr[o + 1]]);
    let remote_port = u16::from_le_bytes([addr[o + 2], addr[o + 3]]);
    let protocol = addr[o + 4];
    Some((local, local_port, remote, remote_port, protocol))
}

fn decode_addr128(bytes: &[u8]) -> std::net::IpAddr {
    // IPv4: only first 4 bytes non-zero and rest zero → treat as v4 in network order.
    if bytes[4..16].iter().all(|&b| b == 0) {
        std::net::IpAddr::V4(std::net::Ipv4Addr::new(
            bytes[0], bytes[1], bytes[2], bytes[3],
        ))
    } else {
        let mut a = [0u8; 16];
        a.copy_from_slice(&bytes[..16]);
        std::net::IpAddr::V6(std::net::Ipv6Addr::from(a))
    }
}
