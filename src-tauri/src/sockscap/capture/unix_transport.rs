//! Linux Unix-domain transport for the privileged capture helper.
//!
//! Peer identity comes only from `SO_PEERCRED` and `/proc/<pid>/exe`; neither a
//! PID, UID, path nor digest claimed in protocol JSON is trusted. A fresh HMAC
//! key is disclosed only over that verified stream and never appears in argv,
//! environment variables, logs, or the recovery database.

use std::fs::{File, OpenOptions};
use std::io::Read;
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde::de::DeserializeOwned;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use uuid::Uuid;
use zeroize::Zeroize;

use super::helper_protocol::{
    AuthenticatedEnvelope, CallerPolicy, HELPER_PROTOCOL_VERSION, MAX_HELPER_LINE_BYTES,
    PeerIdentity, ProtocolError, ProtocolSession, SESSION_KEY_BYTES, decode_json_line,
    encode_json_line, verify_peer_identity,
};

pub const INSTALLED_HELPER_POLICY: &str = "/etc/taomni/sockscap-helper-policy.json";
pub const HELPER_RUNTIME_DIR: &str = "/run/taomni";
pub const HELPER_POLICY_SCHEMA_VERSION: u32 = 1;
const HELPER_POLICY_MAX_BYTES: u64 = 64 * 1024;
const MAX_PINNED_BINARIES: usize = 16;
const BOOTSTRAP_MAGIC: &[u8; 8] = b"TMSCAP01";
const BOOTSTRAP_BYTES: usize = 8 + 4 + 16 + SESSION_KEY_BYTES;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstalledHelperPolicy {
    pub schema_version: u32,
    pub product_id: String,
    pub allowed_caller_sha256: Vec<String>,
    pub allowed_helper_sha256: Vec<String>,
    pub allowed_runtime_sha256: Vec<String>,
}

impl InstalledHelperPolicy {
    pub fn validate(&self) -> Result<(), ProtocolError> {
        if self.schema_version != HELPER_POLICY_SCHEMA_VERSION {
            return Err(ProtocolError::Authentication(format!(
                "helper policy schema must be {HELPER_POLICY_SCHEMA_VERSION}"
            )));
        }
        if self.product_id != "com.taomni.app" {
            return Err(ProtocolError::Authentication(
                "helper policy product id does not match Taomni".into(),
            ));
        }
        validate_digest_pins("caller", &self.allowed_caller_sha256)?;
        validate_digest_pins("helper", &self.allowed_helper_sha256)?;
        validate_digest_pins("runtime", &self.allowed_runtime_sha256)?;
        Ok(())
    }

    pub fn caller_policy(&self, expected_uid: u32) -> CallerPolicy {
        CallerPolicy {
            expected_uid: Some(expected_uid),
            allowed_executable_sha256: self.allowed_caller_sha256.clone(),
            required_signing_identity: None,
        }
    }

    pub fn helper_policy(&self) -> CallerPolicy {
        CallerPolicy {
            expected_uid: Some(0),
            allowed_executable_sha256: self.allowed_helper_sha256.clone(),
            required_signing_identity: None,
        }
    }

    pub fn runtime_policy(&self, expected_uid: u32) -> CallerPolicy {
        CallerPolicy {
            expected_uid: Some(expected_uid),
            allowed_executable_sha256: self.allowed_runtime_sha256.clone(),
            required_signing_identity: None,
        }
    }
}

/// Load a policy through an `O_NOFOLLOW` descriptor and require its owner and
/// write permissions to be trusted. The release helper always passes owner 0;
/// the parameter exists so the same invariant can be unit tested unprivileged.
pub fn load_installed_policy(
    path: &Path,
    required_owner_uid: u32,
) -> Result<InstalledHelperPolicy, ProtocolError> {
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(path)
        .map_err(|error| {
            ProtocolError::Authentication(format!("open installed helper policy: {error}"))
        })?;
    let metadata = file.metadata().map_err(|error| {
        ProtocolError::Authentication(format!("inspect installed helper policy: {error}"))
    })?;
    if !metadata.is_file()
        || metadata.uid() != required_owner_uid
        || metadata.mode() & 0o022 != 0
        || metadata.len() == 0
        || metadata.len() > HELPER_POLICY_MAX_BYTES
    {
        return Err(ProtocolError::Authentication(
            "installed helper policy must be a bounded owner-controlled regular file".into(),
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes).map_err(|error| {
        ProtocolError::Authentication(format!("read installed helper policy: {error}"))
    })?;
    let policy: InstalledHelperPolicy = serde_json::from_slice(&bytes).map_err(|error| {
        ProtocolError::Authentication(format!("decode installed helper policy: {error}"))
    })?;
    policy.validate()?;
    Ok(policy)
}

#[derive(Debug, Clone)]
pub struct UnixPeerPolicy {
    pub expected_pid: Option<u32>,
    pub caller: CallerPolicy,
}

pub fn verified_peer_identity(
    stream: &UnixStream,
    policy: &UnixPeerPolicy,
) -> Result<PeerIdentity, ProtocolError> {
    verified_peer_identity_with_digest(stream, policy, sha256_file)
}

fn verified_peer_identity_with_digest<F>(
    stream: &UnixStream,
    policy: &UnixPeerPolicy,
    digest_executable: F,
) -> Result<PeerIdentity, ProtocolError>
where
    F: FnOnce(&Path) -> Result<String, ProtocolError>,
{
    let credentials = socket_peer_credentials(stream)?;
    if policy
        .expected_pid
        .is_some_and(|expected| expected != credentials.pid)
    {
        return Err(ProtocolError::Authentication(
            "Unix peer PID does not match the launched process".into(),
        ));
    }
    let proc_executable = PathBuf::from(format!("/proc/{}/exe", credentials.pid));
    let executable_path = std::fs::read_link(&proc_executable).map_err(|error| {
        ProtocolError::Authentication(format!("resolve Unix peer executable: {error}"))
    })?;
    let executable_path = executable_path
        .into_os_string()
        .into_string()
        .map_err(|_| {
            ProtocolError::Authentication("Unix peer executable path is not valid UTF-8".into())
        })?;
    let executable_sha256 = digest_executable(&proc_executable)?;
    let peer = PeerIdentity {
        pid: credentials.pid,
        uid: Some(credentials.uid),
        executable_path,
        executable_sha256,
        signing_identity: None,
        platform_verified: true,
    };
    verify_peer_identity(&peer, &policy.caller)?;
    Ok(peer)
}

/// Verify a non-socket runtime (for example the userspace TUN pump) from the
/// kernel-owned procfs view and a release-installed digest pin.
pub fn verified_process_identity(
    pid: u32,
    policy: &CallerPolicy,
) -> Result<PeerIdentity, ProtocolError> {
    if pid == 0 {
        return Err(ProtocolError::Authentication(
            "runtime PID must be non-zero".into(),
        ));
    }
    let proc_dir = PathBuf::from(format!("/proc/{pid}"));
    let uid = std::fs::metadata(&proc_dir)
        .map_err(|error| {
            ProtocolError::Authentication(format!("inspect runtime process: {error}"))
        })?
        .uid();
    let proc_executable = proc_dir.join("exe");
    let executable_path = std::fs::read_link(&proc_executable)
        .map_err(|error| {
            ProtocolError::Authentication(format!("resolve runtime executable: {error}"))
        })?
        .into_os_string()
        .into_string()
        .map_err(|_| {
            ProtocolError::Authentication("runtime executable path is not valid UTF-8".into())
        })?;
    let peer = PeerIdentity {
        pid,
        uid: Some(uid),
        executable_path,
        executable_sha256: sha256_file(&proc_executable)?,
        signing_identity: None,
        platform_verified: true,
    };
    verify_peer_identity(&peer, policy)?;
    Ok(peer)
}

pub fn linux_process_start_token(pid: u32) -> Result<u64, ProtocolError> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).map_err(|error| {
        ProtocolError::Authentication(format!("read runtime process start token: {error}"))
    })?;
    let after_name = stat
        .rsplit_once(')')
        .map(|(_, tail)| tail)
        .ok_or_else(|| ProtocolError::Authentication("runtime process stat is malformed".into()))?;
    // The tail starts at field 3 (state); field 22 (starttime) is index 19.
    after_name
        .split_whitespace()
        .nth(19)
        .ok_or_else(|| {
            ProtocolError::Authentication("runtime process start token is missing".into())
        })?
        .parse()
        .map_err(|_| ProtocolError::Authentication("runtime process start token is invalid".into()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct UnixCredentials {
    pid: u32,
    uid: u32,
}

fn socket_peer_credentials(stream: &UnixStream) -> Result<UnixCredentials, ProtocolError> {
    let mut credentials = libc::ucred {
        pid: 0,
        uid: u32::MAX,
        gid: u32::MAX,
    };
    let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: `credentials` and `length` are valid writable pointers for the
    // declared sizes, and `stream` owns a live Unix socket descriptor.
    let result = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&raw mut credentials).cast(),
            &raw mut length,
        )
    };
    if result != 0 || length as usize != std::mem::size_of::<libc::ucred>() {
        return Err(ProtocolError::Authentication(format!(
            "read Unix peer credentials: {}",
            std::io::Error::last_os_error()
        )));
    }
    let pid = u32::try_from(credentials.pid)
        .map_err(|_| ProtocolError::Authentication("Unix peer returned an invalid PID".into()))?;
    if pid == 0 || credentials.uid == u32::MAX {
        return Err(ProtocolError::Authentication(
            "Unix peer returned empty credentials".into(),
        ));
    }
    Ok(UnixCredentials {
        pid,
        uid: credentials.uid,
    })
}

pub struct HelperChannel {
    stream: BufReader<UnixStream>,
    session: ProtocolSession,
    peer: PeerIdentity,
}

impl HelperChannel {
    pub fn peer(&self) -> &PeerIdentity {
        &self.peer
    }

    pub async fn send<T>(
        &mut self,
        request_id: impl Into<String>,
        generation: u64,
        body: T,
    ) -> Result<(), ProtocolError>
    where
        T: Clone + Serialize,
    {
        let envelope = self.session.sign(request_id, generation, body)?;
        let line = encode_json_line(&envelope)?;
        self.stream
            .get_mut()
            .write_all(&line)
            .await
            .map_err(|error| ProtocolError::Transport(error.to_string()))?;
        self.stream
            .get_mut()
            .flush()
            .await
            .map_err(|error| ProtocolError::Transport(error.to_string()))
    }

    pub async fn receive<T>(&mut self) -> Result<AuthenticatedEnvelope<T>, ProtocolError>
    where
        T: Clone + Serialize + DeserializeOwned,
    {
        let line = read_bounded_line(&mut self.stream).await?;
        let envelope = decode_json_line(&line)?;
        self.session.verify(&envelope)?;
        Ok(envelope)
    }
}

/// Server side: authenticate the app before disclosing a fresh session key.
pub async fn accept_verified_channel(
    stream: UnixStream,
    policy: &UnixPeerPolicy,
) -> Result<HelperChannel, ProtocolError> {
    let peer = verified_peer_identity(&stream, policy)?;
    accept_authenticated_channel(stream, peer).await
}

async fn accept_authenticated_channel(
    mut stream: UnixStream,
    peer: PeerIdentity,
) -> Result<HelperChannel, ProtocolError> {
    let (session_id, mut key, mut frame) = new_bootstrap()?;
    stream
        .write_all(&frame)
        .await
        .map_err(|error| ProtocolError::Transport(error.to_string()))?;
    stream
        .flush()
        .await
        .map_err(|error| ProtocolError::Transport(error.to_string()))?;
    let session = ProtocolSession::new(session_id, &key)?;
    key.zeroize();
    frame.zeroize();
    Ok(HelperChannel {
        stream: BufReader::new(stream),
        session,
        peer,
    })
}

/// Client side: authenticate the root helper before accepting its session key.
pub async fn connect_verified_channel(
    stream: UnixStream,
    policy: &UnixPeerPolicy,
) -> Result<HelperChannel, ProtocolError> {
    let peer = verified_peer_identity(&stream, policy)?;
    connect_authenticated_channel(stream, peer).await
}

async fn connect_authenticated_channel(
    mut stream: UnixStream,
    peer: PeerIdentity,
) -> Result<HelperChannel, ProtocolError> {
    let mut frame = [0_u8; BOOTSTRAP_BYTES];
    stream
        .read_exact(&mut frame)
        .await
        .map_err(|error| ProtocolError::Transport(error.to_string()))?;
    let (session_id, mut key) = decode_bootstrap(&frame)?;
    let session = ProtocolSession::new(session_id, &key)?;
    key.zeroize();
    frame.zeroize();
    Ok(HelperChannel {
        stream: BufReader::new(stream),
        session,
        peer,
    })
}

fn new_bootstrap() -> Result<(String, [u8; SESSION_KEY_BYTES], Vec<u8>), ProtocolError> {
    let session_uuid = Uuid::new_v4();
    let mut key = [0_u8; SESSION_KEY_BYTES];
    rand::fill(&mut key);
    let mut frame = Vec::with_capacity(BOOTSTRAP_BYTES);
    frame.extend_from_slice(BOOTSTRAP_MAGIC);
    frame.extend_from_slice(&HELPER_PROTOCOL_VERSION.to_be_bytes());
    frame.extend_from_slice(session_uuid.as_bytes());
    frame.extend_from_slice(&key);
    Ok((session_uuid.simple().to_string(), key, frame))
}

fn decode_bootstrap(
    frame: &[u8; BOOTSTRAP_BYTES],
) -> Result<(String, [u8; SESSION_KEY_BYTES]), ProtocolError> {
    if &frame[..8] != BOOTSTRAP_MAGIC {
        return Err(ProtocolError::Authentication(
            "helper bootstrap magic is invalid".into(),
        ));
    }
    let version = u32::from_be_bytes(frame[8..12].try_into().expect("fixed version slice"));
    if version != HELPER_PROTOCOL_VERSION {
        return Err(ProtocolError::VersionMismatch {
            expected: HELPER_PROTOCOL_VERSION,
            actual: version,
        });
    }
    let uuid = Uuid::from_slice(&frame[12..28])
        .map_err(|error| ProtocolError::Encoding(error.to_string()))?;
    let mut key = [0_u8; SESSION_KEY_BYTES];
    key.copy_from_slice(&frame[28..]);
    Ok((uuid.simple().to_string(), key))
}

async fn read_bounded_line<R>(reader: &mut R) -> Result<Vec<u8>, ProtocolError>
where
    R: AsyncBufRead + Unpin,
{
    let mut line = Vec::with_capacity(4096);
    loop {
        let available = reader
            .fill_buf()
            .await
            .map_err(|error| ProtocolError::Transport(error.to_string()))?;
        if available.is_empty() {
            return Err(ProtocolError::Transport(
                "helper transport closed before a complete message".into(),
            ));
        }
        let take = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|index| index + 1)
            .unwrap_or(available.len());
        if line.len().saturating_add(take) > MAX_HELPER_LINE_BYTES {
            return Err(ProtocolError::MessageTooLarge(
                line.len().saturating_add(take),
            ));
        }
        let complete = available[..take].last() == Some(&b'\n');
        line.extend_from_slice(&available[..take]);
        reader.consume(take);
        if complete {
            return Ok(line);
        }
    }
}

pub fn helper_socket_path(authorized_uid: u32, generation: u64) -> PathBuf {
    Path::new(HELPER_RUNTIME_DIR).join(format!("sockscap-{authorized_uid}-{generation}.sock"))
}

pub struct BoundHelperSocket {
    pub listener: UnixListener,
    guard: SocketPathGuard,
}

impl BoundHelperSocket {
    pub fn path(&self) -> &Path {
        &self.guard.path
    }
}

/// Bind only below the fixed root-controlled runtime directory. Existing paths
/// are never unlinked implicitly, preventing an attacker from steering helper
/// cleanup at an arbitrary filesystem target.
pub fn bind_helper_socket(
    authorized_uid: u32,
    generation: u64,
) -> Result<BoundHelperSocket, ProtocolError> {
    ensure_runtime_directory()?;
    let path = helper_socket_path(authorized_uid, generation);
    if path.exists() {
        return Err(ProtocolError::Transport(format!(
            "helper socket already exists: {}",
            path.display()
        )));
    }
    let listener = UnixListener::bind(&path)
        .map_err(|error| ProtocolError::Transport(format!("bind helper socket: {error}")))?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
        .map_err(|error| ProtocolError::Transport(format!("protect helper socket: {error}")))?;
    let path_c = std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|_| {
        ProtocolError::Transport("helper socket path contains an embedded NUL".into())
    })?;
    // SAFETY: `path_c` is NUL-terminated and points to the freshly bound socket.
    let chown_result = unsafe { libc::chown(path_c.as_ptr(), authorized_uid, !0 as libc::gid_t) };
    if chown_result != 0 {
        let error = std::io::Error::last_os_error();
        let _ = std::fs::remove_file(&path);
        return Err(ProtocolError::Transport(format!(
            "assign helper socket owner: {error}"
        )));
    }
    let metadata = std::fs::metadata(&path)
        .map_err(|error| ProtocolError::Transport(format!("inspect helper socket: {error}")))?;
    Ok(BoundHelperSocket {
        listener,
        guard: SocketPathGuard {
            path,
            device: metadata.dev(),
            inode: metadata.ino(),
        },
    })
}

fn ensure_runtime_directory() -> Result<(), ProtocolError> {
    let path = Path::new(HELPER_RUNTIME_DIR);
    match std::fs::create_dir(path) {
        Ok(()) => std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).map_err(
            |error| ProtocolError::Transport(format!("protect helper runtime directory: {error}")),
        )?,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => {
            return Err(ProtocolError::Transport(format!(
                "create helper runtime directory: {error}"
            )));
        }
    }
    let metadata = std::fs::symlink_metadata(path).map_err(|error| {
        ProtocolError::Transport(format!("inspect helper runtime directory: {error}"))
    })?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() || metadata.uid() != 0 {
        return Err(ProtocolError::Authentication(
            "helper runtime directory must be a root-owned real directory".into(),
        ));
    }
    if metadata.mode() & 0o022 != 0 {
        return Err(ProtocolError::Authentication(
            "helper runtime directory must not be group/world writable".into(),
        ));
    }
    Ok(())
}

struct SocketPathGuard {
    path: PathBuf,
    device: u64,
    inode: u64,
}

impl Drop for SocketPathGuard {
    fn drop(&mut self) {
        let Ok(metadata) = std::fs::symlink_metadata(&self.path) else {
            return;
        };
        if metadata.file_type().is_socket()
            && metadata.dev() == self.device
            && metadata.ino() == self.inode
        {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

fn sha256_file(path: &Path) -> Result<String, ProtocolError> {
    let mut file = File::open(path)
        .map_err(|error| ProtocolError::Authentication(format!("open peer executable: {error}")))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|error| {
            ProtocolError::Authentication(format!("hash peer executable: {error}"))
        })?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(hex::encode(digest.finalize()))
}

fn validate_digest_pins(label: &str, pins: &[String]) -> Result<(), ProtocolError> {
    if pins.is_empty() || pins.len() > MAX_PINNED_BINARIES {
        return Err(ProtocolError::Authentication(format!(
            "helper policy requires 1-{MAX_PINNED_BINARIES} {label} digests"
        )));
    }
    let mut normalized = std::collections::HashSet::new();
    for pin in pins {
        if pin.len() != 64 || !pin.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(ProtocolError::Authentication(format!(
                "helper policy contains an invalid {label} SHA-256"
            )));
        }
        if !normalized.insert(pin.to_ascii_lowercase()) {
            return Err(ProtocolError::Authentication(format!(
                "helper policy contains a duplicate {label} SHA-256"
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sockscap::capture::helper_protocol::{HelperRequest, HelperResponse};
    use std::io::Write;

    fn current_uid() -> u32 {
        // SAFETY: `geteuid` has no preconditions.
        unsafe { libc::geteuid() }
    }

    fn current_policy() -> UnixPeerPolicy {
        UnixPeerPolicy {
            expected_pid: Some(std::process::id()),
            caller: CallerPolicy {
                expected_uid: Some(current_uid()),
                allowed_executable_sha256: vec!["ab".repeat(32)],
                required_signing_identity: None,
            },
        }
    }

    #[test]
    fn installed_policy_is_owner_checked_and_rejects_duplicate_pins() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("policy.json");
        let digest = "ab".repeat(32);
        let policy = InstalledHelperPolicy {
            schema_version: HELPER_POLICY_SCHEMA_VERSION,
            product_id: "com.taomni.app".into(),
            allowed_caller_sha256: vec![digest.clone()],
            allowed_helper_sha256: vec![digest.clone()],
            allowed_runtime_sha256: vec![digest],
        };
        let mut file = File::create(&path).unwrap();
        serde_json::to_writer(&mut file, &policy).unwrap();
        file.flush().unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(load_installed_policy(&path, current_uid()).unwrap(), policy);

        let mut duplicate = policy;
        duplicate
            .allowed_caller_sha256
            .push(duplicate.allowed_caller_sha256[0].clone());
        assert!(duplicate.validate().is_err());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o622)).unwrap();
        assert!(load_installed_policy(&path, current_uid()).is_err());
    }

    #[tokio::test]
    async fn peer_identity_comes_from_socket_credentials_and_proc_digest() {
        let (left, _right) = UnixStream::pair().unwrap();
        let peer =
            verified_peer_identity_with_digest(&left, &current_policy(), |_| Ok("ab".repeat(32)))
                .unwrap();
        assert_eq!(peer.pid, std::process::id());
        assert_eq!(peer.uid, Some(current_uid()));
        assert!(peer.platform_verified);

        let mut wrong = current_policy();
        wrong.expected_pid = Some(std::process::id().saturating_add(1));
        assert!(
            verified_peer_identity_with_digest(&left, &wrong, |_| Ok("ab".repeat(32))).is_err()
        );
    }

    #[tokio::test]
    async fn verified_bootstrap_supports_authenticated_bidirectional_messages() {
        let (server_stream, client_stream) = UnixStream::pair().unwrap();
        let server_policy = current_policy();
        let client_policy = current_policy();
        let server_peer =
            verified_peer_identity_with_digest(&server_stream, &server_policy, |_| {
                Ok("ab".repeat(32))
            })
            .unwrap();
        let client_peer =
            verified_peer_identity_with_digest(&client_stream, &client_policy, |_| {
                Ok("ab".repeat(32))
            })
            .unwrap();
        let server = tokio::spawn(async move {
            let mut channel = accept_authenticated_channel(server_stream, server_peer)
                .await
                .unwrap();
            let request = channel.receive::<HelperRequest>().await.unwrap();
            assert!(matches!(request.body(), HelperRequest::Probe));
            channel
                .send(
                    request.request_id(),
                    request.generation(),
                    HelperResponse::Shutdown,
                )
                .await
                .unwrap();
        });
        let mut client = connect_authenticated_channel(client_stream, client_peer)
            .await
            .unwrap();
        client
            .send("probe-1", 9, HelperRequest::Probe)
            .await
            .unwrap();
        let response = client.receive::<HelperResponse>().await.unwrap();
        assert_eq!(response.request_id(), "probe-1");
        assert_eq!(response.generation(), 9);
        assert!(matches!(response.body(), HelperResponse::Shutdown));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn bounded_reader_rejects_oversized_line_before_newline() {
        let (mut writer, reader) = UnixStream::pair().unwrap();
        let write = tokio::spawn(async move {
            writer
                .write_all(&vec![b'x'; MAX_HELPER_LINE_BYTES + 1])
                .await
                .unwrap();
        });
        let mut reader = BufReader::new(reader);
        assert!(matches!(
            read_bounded_line(&mut reader).await,
            Err(ProtocolError::MessageTooLarge(_))
        ));
        write.await.unwrap();
    }
}
