//! Windows WinDivert NETWORK NAT engine with process filtering (plan Phase 5).
//!
//! Dynamically loads `WinDivert.dll` (no hard link) so the default Windows
//! build can ship without a machine-local SDK. Outbound TCP is diverted to the
//! local Sockscap transparent port; the original destination is remembered by
//! ephemeral source port. Application / PID selectors are applied by looking up
//! the owning process via the TCP owner table before NAT (plan §5 / §16.4).

#![cfg(windows)]
#![allow(non_snake_case, non_camel_case_types, dead_code)]

use std::collections::{HashMap, HashSet};
use std::ffi::CString;
use std::net::Ipv4Addr;
use std::os::raw::{c_char, c_void};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use super::packet;
use super::windows_pid::{process_image_path, tcp_owner_map};

type HANDLE = *mut c_void;
const INVALID_HANDLE_VALUE: isize = -1;
const WINDIVERT_LAYER_NETWORK: i32 = 0;

#[repr(C)]
#[derive(Clone, Copy)]
struct WinDivertAddress {
    timestamp: i64,
    flags: u32,
    reserved2: u32,
    union: [u8; 64],
}

impl WinDivertAddress {
    fn zeroed() -> Self {
        Self {
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

type FnOpen = unsafe extern "C" fn(*const c_char, i32, i16, u64) -> HANDLE;
type FnRecv = unsafe extern "C" fn(HANDLE, *mut c_void, u32, *mut u32, *mut WinDivertAddress) -> i32;
type FnSend = unsafe extern "C" fn(HANDLE, *const c_void, u32, *mut u32, *const WinDivertAddress) -> i32;
type FnClose = unsafe extern "C" fn(HANDLE) -> i32;

struct Api {
    _lib: winapi::shared::minwindef::HMODULE,
    open: FnOpen,
    recv: FnRecv,
    send: FnSend,
    close: FnClose,
}

// SAFETY: function pointers come from a loaded DLL and stay valid while `_lib` is held.
unsafe impl Send for Api {}
unsafe impl Sync for Api {}

impl Api {
    fn load_from(dir: Option<&Path>) -> Result<Api, String> {
        use std::os::windows::ffi::OsStrExt;
        use winapi::um::libloaderapi::{GetProcAddress, LoadLibraryW};

        let candidates: Vec<PathBuf> = {
            let mut v = Vec::new();
            if let Some(d) = dir {
                v.push(d.join("WinDivert.dll"));
            }
            v.push(PathBuf::from(r"C:\Windows\System32\WinDivert.dll"));
            v.push(PathBuf::from("WinDivert.dll"));
            if let Ok(exe) = std::env::current_exe() {
                if let Some(p) = exe.parent() {
                    v.push(p.join("WinDivert.dll"));
                    v.push(p.join("resources").join("windivert").join("WinDivert.dll"));
                }
            }
            v.push(PathBuf::from("src-tauri/resources/windivert/WinDivert.dll"));
            v
        };
        let dll_path = candidates
            .into_iter()
            .find(|p| p.exists())
            .ok_or_else(|| "WinDivert.dll not found (install driver runtime first)".to_string())?;

        let wide: Vec<u16> = dll_path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let lib = unsafe { LoadLibraryW(wide.as_ptr()) };
        if lib.is_null() {
            return Err(format!("LoadLibrary({}) failed", dll_path.display()));
        }
        unsafe fn sym<T>(lib: winapi::shared::minwindef::HMODULE, name: &str) -> Result<T, String> {
            let c = CString::new(name).unwrap();
            let p = unsafe { GetProcAddress(lib, c.as_ptr()) };
            if p.is_null() {
                return Err(format!("GetProcAddress({name}) failed"));
            }
            Ok(unsafe { std::mem::transmute_copy(&p) })
        }
        unsafe {
            Ok(Api {
                _lib: lib,
                open: sym(lib, "WinDivertOpen")?,
                recv: sym(lib, "WinDivertRecv")?,
                send: sym(lib, "WinDivertSend")?,
                close: sym(lib, "WinDivertClose")?,
            })
        }
    }
}

/// Original destination + process identity for a redirected flow.
#[derive(Debug, Clone)]
pub struct FlowIdentity {
    pub dst: Ipv4Addr,
    pub dport: u16,
    pub pid: Option<u32>,
    pub exe: Option<String>,
}

pub type ConnTrack = Arc<Mutex<HashMap<u16, FlowIdentity>>>;

/// Which processes to divert. `All` = global transparent capture.
#[derive(Debug, Clone)]
pub enum ProcessFilter {
    All,
    /// Match by lowercase full path or file name.
    Executables(HashSet<String>),
    /// Match exact PIDs (runtime-process scope).
    Pids(HashSet<u32>),
}

impl ProcessFilter {
    fn allows(&self, pid: Option<u32>, exe: Option<&str>) -> bool {
        match self {
            ProcessFilter::All => true,
            ProcessFilter::Pids(set) => pid.map(|p| set.contains(&p)).unwrap_or(false),
            ProcessFilter::Executables(set) => {
                let Some(path) = exe else {
                    return false;
                };
                let lower = path.replace('/', "\\").to_ascii_lowercase();
                if set.contains(&lower) {
                    return true;
                }
                Path::new(&lower)
                    .file_name()
                    .and_then(|s| s.to_str())
                    .map(|n| set.contains(n))
                    .unwrap_or(false)
            }
        }
    }
}

/// Running WinDivert NAT engine (background thread).
pub struct WinDivertEngine {
    running: Arc<AtomicBool>,
    pub conntrack: ConnTrack,
    join: Option<JoinHandle<()>>,
}

impl WinDivertEngine {
    /// Start NETWORK divert → local_port NAT with optional process filter.
    pub fn start(
        local_port: u16,
        dll_dir: Option<&Path>,
        filter: ProcessFilter,
    ) -> Result<WinDivertEngine, String> {
        let api = Arc::new(Api::load_from(dll_dir)?);
        let filter_str = CString::new(format!(
            "tcp and ((outbound and remoteAddr != 127.0.0.1 and tcp.DstPort != {local_port}) or \
             (loopback and tcp.SrcPort == {local_port}))"
        ))
        .map_err(|e| e.to_string())?;
        let handle = unsafe { (api.open)(filter_str.as_ptr(), WINDIVERT_LAYER_NETWORK, 0, 0) };
        if handle.is_null() || handle as isize == INVALID_HANDLE_VALUE {
            return Err(
                "WinDivertOpen failed (need Administrator + installed WinDivert64.sys)".into(),
            );
        }
        // Pass as usize so the thread closure is Send (*mut c_void is !Send).
        let handle_bits = handle as usize;

        let running = Arc::new(AtomicBool::new(true));
        let conntrack: ConnTrack = Arc::new(Mutex::new(HashMap::new()));
        let run_flag = running.clone();
        let track = conntrack.clone();
        let api_t = api.clone();
        let join = std::thread::Builder::new()
            .name("sockscap-windivert".into())
            .spawn(move || {
                let handle = handle_bits as HANDLE;
                run_loop(api_t, handle, local_port, run_flag, track, filter);
            })
            .map_err(|e| format!("spawn windivert thread: {e}"))?;

        Ok(WinDivertEngine {
            running,
            conntrack,
            join: Some(join),
        })
    }

    pub fn stop(mut self) {
        self.running.store(false, Ordering::SeqCst);
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

impl Drop for WinDivertEngine {
    fn drop(&mut self) {
        self.running.store(false, Ordering::SeqCst);
    }
}

fn run_loop(
    api: Arc<Api>,
    handle: HANDLE,
    local_port: u16,
    running: Arc<AtomicBool>,
    conntrack: ConnTrack,
    filter: ProcessFilter,
) {
    let mut buf = vec![0u8; 65535];
    let mut addr = WinDivertAddress::zeroed();
    let mut owners = HashMap::new();
    let mut owner_refresh = std::time::Instant::now();

    while running.load(Ordering::Relaxed) {
        if owner_refresh.elapsed() > std::time::Duration::from_millis(500) {
            owners = tcp_owner_map();
            owner_refresh = std::time::Instant::now();
        }
        let mut recv_len: u32 = 0;
        let ok = unsafe {
            (api.recv)(
                handle,
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
            nat_forward(pkt, local_port, &conntrack, &filter, &owners);
        } else {
            nat_reverse(pkt, &conntrack);
        }
        let mut send_len: u32 = 0;
        unsafe {
            (api.send)(
                handle,
                pkt.as_ptr() as *const c_void,
                recv_len,
                &mut send_len,
                &addr,
            );
        }
    }
    unsafe {
        (api.close)(handle);
    }
}

fn nat_forward(
    pkt: &mut [u8],
    local_port: u16,
    conntrack: &ConnTrack,
    filter: &ProcessFilter,
    owners: &HashMap<u16, u32>,
) {
    let (Some(dst), Some(dport)) = (packet::ipv4_dst(pkt), packet::tcp_dst_port(pkt)) else {
        return;
    };
    let Some(ihl) = packet::ipv4_header_len(pkt) else {
        return;
    };
    if pkt.len() < ihl + 2 {
        return;
    }
    let sport = u16::from_be_bytes([pkt[ihl], pkt[ihl + 1]]);
    let pid = owners.get(&sport).copied();
    let exe = pid.and_then(process_image_path).map(|p| p.to_string_lossy().into_owned());
    if !filter.allows(pid, exe.as_deref()) {
        // Not selected — reinject unmodified (already will be sent as-is).
        return;
    }
    conntrack.lock().unwrap().insert(
        sport,
        FlowIdentity {
            dst,
            dport,
            pid,
            exe,
        },
    );
    let _ = packet::redirect_ipv4_tcp(pkt, Ipv4Addr::LOCALHOST, local_port);
}

fn nat_reverse(pkt: &mut [u8], conntrack: &ConnTrack) {
    let Some(ihl) = packet::ipv4_header_len(pkt) else {
        return;
    };
    if pkt.len() < ihl + 4 {
        return;
    }
    let dport = u16::from_be_bytes([pkt[ihl + 2], pkt[ihl + 3]]);
    if let Some(info) = conntrack.lock().unwrap().get(&dport).cloned() {
        pkt[12..16].copy_from_slice(&info.dst.octets());
        pkt[ihl..ihl + 2].copy_from_slice(&info.dport.to_be_bytes());
        let _ = packet::fix_ipv4_checksum(pkt);
        let _ = packet::fix_tcp_checksum(pkt);
    }
}

/// Quick open/close to verify the driver loads (needs elevation + installed files).
pub fn smoke_open(dll_dir: Option<&Path>) -> Result<(), String> {
    let api = Api::load_from(dll_dir)?;
    let filter = CString::new("false").unwrap();
    let h = unsafe { (api.open)(filter.as_ptr(), WINDIVERT_LAYER_NETWORK, 0, 0) };
    if h.is_null() || h as isize == INVALID_HANDLE_VALUE {
        return Err("WinDivertOpen smoke test failed (Administrator required?)".into());
    }
    unsafe {
        (api.close)(h);
    }
    Ok(())
}
