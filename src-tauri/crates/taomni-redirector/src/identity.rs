//! Validates the pinned Redirector and its Darwin Unix-socket peers.

use std::{
    io::Read,
    os::fd::AsRawFd,
    path::{Path, PathBuf},
    process::Command,
};

use sha2::{Digest, Sha256};

use crate::{
    REDIRECTOR_EXTENSION_BUNDLE_ID, REDIRECTOR_EXTENSION_EXECUTABLE_SHA256, REDIRECTOR_TEAM_ID,
    REDIRECTOR_VERSION,
};

pub fn verify_signature(path: &Path, bundle_id: &str) -> Result<(), String> {
    let verified = Command::new("/usr/bin/codesign")
        .args(["--verify", "--deep", "--strict", "--verbose=2"])
        .arg(path)
        .output()
        .map_err(|error| format!("run codesign for {}: {error}", path.display()))?;
    if !verified.status.success() {
        return Err(format!(
            "Mitmproxy Redirector signature verification failed for {}: {}",
            path.display(),
            String::from_utf8_lossy(&verified.stderr).trim()
        ));
    }

    let details = Command::new("/usr/bin/codesign")
        .args(["-d", "--verbose=4"])
        .arg(path)
        .output()
        .map_err(|error| format!("read codesign identity for {}: {error}", path.display()))?;
    if !details.status.success() {
        return Err(format!(
            "read Mitmproxy Redirector signature identity for {}: {}",
            path.display(),
            String::from_utf8_lossy(&details.stderr).trim()
        ));
    }
    let details = String::from_utf8_lossy(&details.stderr);
    if !details
        .lines()
        .any(|line| line == format!("Identifier={bundle_id}"))
        || !details
            .lines()
            .any(|line| line == format!("TeamIdentifier={REDIRECTOR_TEAM_ID}"))
    {
        return Err(format!(
            "Mitmproxy Redirector identity mismatch for {} (expected bundle {bundle_id}, Team ID {REDIRECTOR_TEAM_ID})",
            path.display()
        ));
    }
    Ok(())
}

pub fn verify_sha256(path: &Path, expected: &str) -> Result<(), String> {
    let mut file = std::fs::File::open(path)
        .map_err(|error| format!("open pinned Redirector file {}: {error}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("hash pinned Redirector file {}: {error}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let actual = hex::encode(hasher.finalize());
    if actual != expected {
        return Err(format!(
            "Mitmproxy Redirector {REDIRECTOR_VERSION} file hash mismatch for {}: {actual}",
            path.display()
        ));
    }
    Ok(())
}

/// Resolve and verify the process on the other end of a Redirector Unix
/// connection. File permissions alone are insufficient because the first
/// connection is the privileged control channel in the upstream protocol.
pub fn verify_redirector_peer(stream: &tokio::net::UnixStream) -> Result<u32, String> {
    let pid = redirector_peer_pid(stream)?;
    let process_path = process_path(pid)?;
    let extension_bundle = process_path
        .ancestors()
        .find(|path| {
            path.extension().and_then(|extension| extension.to_str()) == Some("systemextension")
        })
        .ok_or_else(|| {
            format!(
                "Redirector peer executable is not inside a systemextension: {}",
                process_path.display()
            )
        })?;
    verify_signature(extension_bundle, REDIRECTOR_EXTENSION_BUNDLE_ID)?;
    verify_sha256(&process_path, REDIRECTOR_EXTENSION_EXECUTABLE_SHA256)?;
    Ok(pid)
}

/// Return a Unix peer pid only after Darwin's peer pid and audit token agree.
/// The bridge performs the expensive signature/hash verification once for the
/// control connection, then uses this lightweight check for each flow socket
/// and requires it to have the same pid.
pub fn redirector_peer_pid(stream: &tokio::net::UnixStream) -> Result<u32, String> {
    const SOL_LOCAL: libc::c_int = 0;
    const LOCAL_PEERPID: libc::c_int = 0x002;
    const LOCAL_PEERTOKEN: libc::c_int = 0x006;
    const AUDIT_TOKEN_PID_INDEX: usize = 5;

    let fd = stream.as_raw_fd();
    let mut pid: libc::pid_t = 0;
    let mut pid_len = std::mem::size_of::<libc::pid_t>() as libc::socklen_t;
    let pid_status = unsafe {
        libc::getsockopt(
            fd,
            SOL_LOCAL,
            LOCAL_PEERPID,
            (&mut pid as *mut libc::pid_t).cast(),
            &mut pid_len,
        )
    };
    if pid_status != 0 || pid <= 0 {
        return Err(format!(
            "read Redirector Unix peer pid: {}",
            std::io::Error::last_os_error()
        ));
    }

    // Darwin's audit_token_t is eight u32 values. Validate that its pid agrees
    // with LOCAL_PEERPID so a malformed or unexpected peer is rejected before
    // any protobuf bytes are trusted.
    let mut audit_token = [0u32; 8];
    let mut token_len = std::mem::size_of_val(&audit_token) as libc::socklen_t;
    let token_status = unsafe {
        libc::getsockopt(
            fd,
            SOL_LOCAL,
            LOCAL_PEERTOKEN,
            audit_token.as_mut_ptr().cast(),
            &mut token_len,
        )
    };
    if token_status != 0
        || token_len as usize != std::mem::size_of_val(&audit_token)
        || audit_token[AUDIT_TOKEN_PID_INDEX] != pid as u32
    {
        return Err(format!(
            "Redirector Unix peer audit token does not match pid {pid}"
        ));
    }

    Ok(pid as u32)
}

pub fn process_path(pid: u32) -> Result<PathBuf, String> {
    let mut buffer = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    let length = unsafe {
        libc::proc_pidpath(
            pid as libc::c_int,
            buffer.as_mut_ptr().cast(),
            buffer.len() as u32,
        )
    };
    if length <= 0 {
        return Err(format!(
            "resolve Redirector peer pid {pid}: {}",
            std::io::Error::last_os_error()
        ));
    }
    let path = String::from_utf8(buffer[..length as usize].to_vec())
        .map_err(|_| format!("Redirector peer pid {pid} has a non-UTF-8 executable path"))?;
    Ok(PathBuf::from(path))
}
