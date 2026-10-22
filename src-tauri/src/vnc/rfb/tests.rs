use super::*;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::thread;

fn write_server_init(stream: &mut TcpStream, width: u16, height: u16, name: &[u8]) {
    let mut init = Vec::with_capacity(24 + name.len());
    init.extend_from_slice(&width.to_be_bytes());
    init.extend_from_slice(&height.to_be_bytes());
    init.extend_from_slice(&[32, 24, 0, 1]);
    init.extend_from_slice(&255u16.to_be_bytes());
    init.extend_from_slice(&255u16.to_be_bytes());
    init.extend_from_slice(&255u16.to_be_bytes());
    init.extend_from_slice(&[0, 8, 16, 0, 0, 0]);
    init.extend_from_slice(&(name.len() as u32).to_be_bytes());
    init.extend_from_slice(name);
    stream.write_all(&init).unwrap();
}

fn start_fixture(
    minor: u16,
    security: u32,
    width: u16,
    height: u16,
    name: &[u8],
) -> (u16, thread::JoinHandle<()>) {
    let name = name.to_vec();
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let handle = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let banner = format!("RFB 003.{minor:03}\n");
        stream.write_all(banner.as_bytes()).unwrap();
        let mut client_banner = [0u8; 12];
        stream.read_exact(&mut client_banner).unwrap();

        if minor <= 3 {
            stream.write_all(&security.to_be_bytes()).unwrap();
        } else {
            let security_type = security as u8;
            stream.write_all(&[1, security_type]).unwrap();
            let mut chosen = [0u8; 1];
            if stream.read_exact(&mut chosen).is_err() {
                return;
            }
            assert_eq!(chosen[0], security_type);
        }

        if security == 2 {
            let challenge = [0x5au8; 16];
            stream.write_all(&challenge).unwrap();
            let mut response = [0u8; 16];
            stream.read_exact(&mut response).unwrap();
            assert_eq!(response, vnc_des_encrypt("passw0rd", &challenge));
            stream.write_all(&0u32.to_be_bytes()).unwrap();
        } else if minor >= 8 {
            stream.write_all(&0u32.to_be_bytes()).unwrap();
        }

        let mut client_init = [0u8; 1];
        stream.read_exact(&mut client_init).unwrap();
        assert_eq!(client_init[0], 1);
        write_server_init(&mut stream, width, height, &name);
    });
    (port, handle)
}

fn connect_fixture(
    port: u16,
    policy: VncSecurityPolicy,
    limits: DecodeLimits,
) -> Result<ServerInit, String> {
    let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let mut connection =
        RfbConnection::from_stream(stream, Duration::from_secs(2), policy, limits)?;
    connection.authenticate(None, Some("passw0rd"))
}

#[test]
fn test_reverse_bits() {
    assert_eq!(reverse_bits(0b0000_0001), 0b1000_0000);
    assert_eq!(reverse_bits(0b1000_0000), 0b0000_0001);
    assert_eq!(reverse_bits(0b1111_0000), 0b0000_1111);
}

#[test]
fn test_vnc_des_known_vector() {
    // Test vector: password "passw0rd", challenge all zeros
    let challenge = [0u8; 16];
    let response = vnc_des_encrypt("passw0rd", &challenge);
    // Verify the response is 16 bytes and not all zeros
    assert_eq!(response.len(), 16);
    assert!(response.iter().any(|&b| b != 0));
}

#[test]
fn supports_rfb_33_37_and_38_none_fixtures() {
    for minor in [3, 7, 8] {
        let (port, server) = start_fixture(minor, 1, 800, 600, b"fixture");
        let result =
            connect_fixture(port, VncSecurityPolicy::AllowNone, DecodeLimits::default()).unwrap();
        assert_eq!((result.width, result.height), (800, 600));
        assert_eq!(result.name, "fixture");
        server.join().unwrap();
    }
}

#[test]
fn rejects_none_fixture_without_explicit_opt_in() {
    let (port, server) = start_fixture(8, 1, 800, 600, b"fixture");
    let result = connect_fixture(
        port,
        VncSecurityPolicy::PreferEncryption,
        DecodeLimits::default(),
    );
    assert!(result.unwrap_err().contains("allow-none"));
    server.join().unwrap();
}

/// RFC 2409 Oakley group 2 (1024-bit MODP), the size macOS uses for ARD.
const OAKLEY_GROUP_2: &str = "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74\
        020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F1437\
        4FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED\
        EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE65381FFFFFFFFFFFFFFFF";

/// Deterministic bytes for reproducible tests.
struct CountingRng(u8);

impl rsa::rand_core::RngCore for CountingRng {
    fn next_u32(&mut self) -> u32 {
        let mut bytes = [0u8; 4];
        self.fill_bytes(&mut bytes);
        u32::from_le_bytes(bytes)
    }
    fn next_u64(&mut self) -> u64 {
        let mut bytes = [0u8; 8];
        self.fill_bytes(&mut bytes);
        u64::from_le_bytes(bytes)
    }
    fn fill_bytes(&mut self, dest: &mut [u8]) {
        for byte in dest {
            self.0 = self.0.wrapping_mul(31).wrapping_add(17);
            *byte = self.0;
        }
    }
    fn try_fill_bytes(&mut self, dest: &mut [u8]) -> Result<(), rsa::rand_core::Error> {
        self.fill_bytes(dest);
        Ok(())
    }
}

fn hex_bytes(hex: &str) -> Vec<u8> {
    let hex: String = hex.chars().filter(|c| !c.is_whitespace()).collect();
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
        .collect()
}

/// The server half of ARD: decrypt the credentials the client sent.
fn ard_server_decrypt(
    prime: &[u8],
    server_private: &rsa::BigUint,
    credentials: &[u8],
    client_public: &[u8],
) -> (String, String) {
    use aes::cipher::{Array, BlockCipherDecrypt, KeyInit};
    use md5::Digest;

    let p = rsa::BigUint::from_bytes_be(prime);
    let shared = rsa::BigUint::from_bytes_be(client_public).modpow(server_private, &p);
    let shared = left_pad(&shared.to_bytes_be(), prime.len(), "shared").unwrap();
    let cipher = aes::Aes128::new_from_slice(&md5::Md5::digest(&shared)).unwrap();
    let mut plain = credentials.to_vec();
    for chunk in plain.chunks_exact_mut(16) {
        cipher.decrypt_block(Array::from_mut_slice(chunk));
    }
    let field = |range: std::ops::Range<usize>| {
        let bytes = &plain[range];
        let end = bytes.iter().position(|b| *b == 0).unwrap();
        String::from_utf8(bytes[..end].to_vec()).unwrap()
    };
    (field(0..64), field(64..128))
}

#[test]
fn ard_response_encrypts_credentials_under_the_dh_secret() {
    let prime = hex_bytes(OAKLEY_GROUP_2);
    let p = rsa::BigUint::from_bytes_be(&prime);
    let server_private = rsa::BigUint::from(0x1234_5678_9abc_def1u64);
    let server_public = rsa::BigUint::from(2u32).modpow(&server_private, &p);
    let server_public = left_pad(&server_public.to_bytes_be(), 128, "public").unwrap();
    let (credentials, client_public) = ard_response(
        2,
        &prime,
        &server_public,
        "runner",
        "pässwörd",
        &mut CountingRng(1),
    )
    .unwrap();
    assert_eq!(client_public.len(), 128);
    assert_eq!(
        ard_server_decrypt(&prime, &server_private, &credentials, &client_public),
        ("runner".to_string(), "pässwörd".to_string())
    );
    // Fresh randomness gives a different key pair and ciphertext.
    let (other, other_public) = ard_response(
        2,
        &prime,
        &server_public,
        "runner",
        "pässwörd",
        &mut CountingRng(2),
    )
    .unwrap();
    assert_ne!(other, credentials);
    assert_ne!(other_public, client_public);
}

#[test]
fn ard_response_rejects_bad_parameters_and_long_credentials() {
    let prime = hex_bytes(OAKLEY_GROUP_2);
    let mut rng = CountingRng(3);
    let one = left_pad(&[1], 128, "one").unwrap();
    assert!(ard_response(2, &prime, &one, "u", "p", &mut rng).is_err());
    assert!(ard_response(2, &prime, &prime, "u", "p", &mut rng).is_err());
    let public = left_pad(&[5], 128, "five").unwrap();
    assert!(ard_response(1, &prime, &public, "u", "p", &mut rng).is_err());
    let long = "x".repeat(64);
    assert!(ard_response(2, &prime, &public, &long, "p", &mut rng).is_err());
    assert!(ard_response(2, &prime, &public, "u", &long, &mut rng).is_err());
    assert!(ard_response(2, &prime, &public, "u", "p\0q", &mut rng).is_err());
    assert!(ard_response(2, &prime, &public, &"x".repeat(63), "p", &mut rng).is_ok());
}

/// macOS-style server: RFB 003.889, offers [30, 2], checks ARD credentials.
fn start_ard_fixture(expected: (&'static str, &'static str)) -> (u16, thread::JoinHandle<u8>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let handle = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        stream.write_all(b"RFB 003.889\n").unwrap();
        let mut client_banner = [0u8; 12];
        stream.read_exact(&mut client_banner).unwrap();
        assert_eq!(&client_banner, b"RFB 003.008\n");
        stream.write_all(&[2, 30, 2]).unwrap();
        let mut chosen = [0u8; 1];
        stream.read_exact(&mut chosen).unwrap();
        if chosen[0] != 30 {
            return chosen[0];
        }
        let prime = hex_bytes(OAKLEY_GROUP_2);
        let p = rsa::BigUint::from_bytes_be(&prime);
        let server_private = rsa::BigUint::from(0xfeed_beef_u64);
        let server_public = rsa::BigUint::from(2u32).modpow(&server_private, &p);
        let mut parameters = vec![0, 2, 0, 128];
        parameters.extend_from_slice(&prime);
        parameters.extend_from_slice(&left_pad(&server_public.to_bytes_be(), 128, "pub").unwrap());
        stream.write_all(&parameters).unwrap();
        let mut credentials = [0u8; 128];
        stream.read_exact(&mut credentials).unwrap();
        let mut client_public = [0u8; 128];
        stream.read_exact(&mut client_public).unwrap();
        let (user, password) =
            ard_server_decrypt(&prime, &server_private, &credentials, &client_public);
        if (user.as_str(), password.as_str()) != expected {
            let reason = b"Authentication failed";
            stream.write_all(&1u32.to_be_bytes()).unwrap();
            stream
                .write_all(&(reason.len() as u32).to_be_bytes())
                .unwrap();
            stream.write_all(reason).unwrap();
            return chosen[0];
        }
        stream.write_all(&0u32.to_be_bytes()).unwrap();
        let mut client_init = [0u8; 1];
        stream.read_exact(&mut client_init).unwrap();
        write_server_init(&mut stream, 1440, 900, b"Mac mini");
        chosen[0]
    });
    (port, handle)
}

fn connect_ard(port: u16, username: Option<&str>, password: &str) -> Result<ServerInit, String> {
    let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let mut connection = RfbConnection::from_stream(
        stream,
        Duration::from_secs(5),
        VncSecurityPolicy::PreferEncryption,
        DecodeLimits::default(),
    )?;
    let init = connection.authenticate(username, Some(password))?;
    assert_eq!(connection.protocol_version(), "3.8");
    Ok(init)
}

#[test]
fn authenticates_mac_screen_sharing_with_ard_when_a_username_is_given() {
    let (port, server) = start_ard_fixture(("runner", "Qa1-secret"));
    let init = connect_ard(port, Some("runner"), "Qa1-secret").unwrap();
    assert_eq!(
        (init.width, init.height, init.name.as_str()),
        (1440, 900, "Mac mini")
    );
    assert_eq!(server.join().unwrap(), 30);

    let (port, server) = start_ard_fixture(("runner", "Qa1-secret"));
    let error = connect_ard(port, Some("runner"), "wrong").unwrap_err();
    assert!(error.contains("authentication failed"), "{error}");
    assert_eq!(server.join().unwrap(), 30);
}

#[test]
fn mac_server_without_a_username_falls_back_to_vncauth() {
    let (port, server) = start_ard_fixture(("runner", "Qa1-secret"));
    // The fixture stops after the choice; the client then fails reading
    // the VNCAuth challenge, which is all this test needs.
    let _ = connect_ard(port, None, "Qa1-secret");
    assert_eq!(server.join().unwrap(), 2);
}

/// A VNCAuth server that reports whether the client answered its
/// challenge: `Some(true)` response sent, `Some(false)` the client hung up
/// first, `None` it never got as far as the challenge (3.8 selection).
fn start_vncauth_probe(minor: u16) -> (u16, thread::JoinHandle<Option<bool>>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let handle = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        stream
            .write_all(format!("RFB 003.{minor:03}\n").as_bytes())
            .unwrap();
        let mut client_banner = [0u8; 12];
        stream.read_exact(&mut client_banner).unwrap();
        if minor <= 3 {
            stream.write_all(&2u32.to_be_bytes()).unwrap();
        } else {
            stream.write_all(&[1, 2]).unwrap();
            let mut chosen = [0u8; 1];
            if stream.read_exact(&mut chosen).is_err() {
                return None;
            }
        }
        stream.write_all(&[0x5au8; 16]).unwrap();
        let mut response = [0u8; 16];
        Some(stream.read_exact(&mut response).is_ok())
    });
    (port, handle)
}

#[test]
fn vncauth_without_a_password_asks_instead_of_answering_the_challenge() {
    for minor in [3, 8] {
        let (port, server) = start_vncauth_probe(minor);
        let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let mut connection = RfbConnection::from_stream(
            stream,
            Duration::from_secs(2),
            VncSecurityPolicy::PreferEncryption,
            DecodeLimits::default(),
        )
        .unwrap();
        let error = connection.authenticate(None, None).unwrap_err();
        assert_eq!(error, CREDENTIALS_REQUIRED, "RFB 3.{minor}");
        drop(connection);
        let answered = server.join().unwrap();
        assert_ne!(answered, Some(true), "RFB 3.{minor}: no challenge response");
    }
    assert!(missing_password(Some("")));
    assert!(!missing_password(Some("secret12")));
    assert!(needs_password(SEC_TYPE_ARD) && needs_password(SEC_TYPE_RA2_256));
    assert!(!needs_password(SEC_TYPE_NONE));
}

#[test]
fn authenticates_vncauth_fixture_and_reads_server_init() {
    let (port, server) = start_fixture(8, 2, 1024, 768, b"auth fixture");
    let result = connect_fixture(
        port,
        VncSecurityPolicy::PreferEncryption,
        DecodeLimits::default(),
    )
    .unwrap();
    assert_eq!((result.width, result.height), (1024, 768));
    assert_eq!(result.name, "auth fixture");
    server.join().unwrap();
}

#[test]
fn server_init_limits_dimensions_and_name_before_allocation() {
    let mut limits = DecodeLimits::default();
    limits.max_framebuffer_dimension = 100;
    let (port, server) = start_fixture(8, 1, 101, 80, b"fixture");
    let result = connect_fixture(port, VncSecurityPolicy::AllowNone, limits);
    assert!(result.unwrap_err().contains("dimensions exceed"));
    server.join().unwrap();

    let mut limits = DecodeLimits::default();
    limits.max_server_string_bytes = 4;
    let (port, server) = start_fixture(8, 1, 80, 60, b"too long");
    let result = connect_fixture(port, VncSecurityPolicy::AllowNone, limits);
    assert!(result.unwrap_err().contains("server name exceeds"));
    server.join().unwrap();
}

#[test]
fn server_disconnect_is_reported_without_panicking() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream.write_all(b"RFB 003.008\n").unwrap();
        let mut client_banner = [0u8; 12];
        stream.read_exact(&mut client_banner).unwrap();
    });
    let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let mut connection = RfbConnection::from_stream(
        stream,
        Duration::from_secs(2),
        VncSecurityPolicy::AllowNone,
        DecodeLimits::default(),
    )
    .unwrap();
    assert!(connection.read_server_message().is_err());
    server.join().unwrap();
}

#[test]
fn runtime_mode_clears_the_handshake_read_timeout() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let address = listener.local_addr().unwrap();
    let client = TcpStream::connect(address).unwrap();
    let (_server, _) = listener.accept().unwrap();
    let mut connection = RfbConnection::new_stream(
        client,
        Duration::from_secs(2),
        DecodeLimits::default(),
        VncSecurityPolicy::AllowNone,
        8,
        None,
        None,
    )
    .unwrap();
    assert_eq!(
        connection.stream.read_timeout().unwrap(),
        Some(Duration::from_secs(2))
    );
    assert!(!connection.read_buffer.enabled);
    connection.enter_runtime_mode().unwrap();
    assert_eq!(connection.stream.read_timeout().unwrap(), None);
    assert!(connection.read_buffer.enabled);
}

#[test]
fn buffered_runtime_reads_decode_many_small_hextile_tiles() {
    // 32x16 Hextile rectangle = two tiles, each "bg specified" (5 bytes):
    // many tiny reads that the runtime buffer must serve exactly, followed
    // by a Raw rectangle whose body bypasses the buffer.
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let address = listener.local_addr().unwrap();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut update = vec![0, 0, 0, 2];
        for value in [0u16, 0, 32, 16] {
            update.extend_from_slice(&value.to_be_bytes());
        }
        update.extend_from_slice(&5i32.to_be_bytes());
        update.extend_from_slice(&[0x02, 9, 8, 7, 0]);
        update.extend_from_slice(&[0x02, 1, 2, 3, 0]);
        for value in [0u16, 16, 1, 1] {
            update.extend_from_slice(&value.to_be_bytes());
        }
        update.extend_from_slice(&0i32.to_be_bytes());
        update.extend_from_slice(&[4, 5, 6, 0]);
        stream.write_all(&update).unwrap();
    });
    let stream = TcpStream::connect(address).unwrap();
    let mut connection = RfbConnection::new_stream(
        stream,
        Duration::from_secs(2),
        DecodeLimits::default(),
        VncSecurityPolicy::AllowNone,
        8,
        None,
        None,
    )
    .unwrap();
    connection.width = 32;
    connection.height = 17;
    connection.framebuffer = Framebuffer::new(32, 17, &DecodeLimits::default())
        .unwrap()
        .shared();
    connection.enter_runtime_mode().unwrap();
    match connection.read_server_message().unwrap() {
        ServerMessage::FramebufferUpdate { rects, .. } => {
            assert_eq!(
                rects,
                vec![FbRect::new(0, 0, 32, 16), FbRect::new(0, 16, 1, 1)]
            );
        }
        other => panic!("expected framebuffer update, got {other:?}"),
    }
    let fb = connection.framebuffer();
    let fb = fb.lock().unwrap();
    let relay = fb.relay_frame(FbRect::new(15, 0, 2, 1)).unwrap();
    assert_eq!(&relay[12..], &[9, 8, 7, 255, 1, 2, 3, 255]);
    let raw = fb.relay_frame(FbRect::new(0, 16, 1, 1)).unwrap();
    assert_eq!(&raw[12..], &[4, 5, 6, 255]);
    server.join().unwrap();
}

#[test]
fn decodes_pointer_position_pseudo_encoding_without_a_pixel_payload() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let address = listener.local_addr().unwrap();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut update = Vec::new();
        update.extend_from_slice(&[0, 0, 0, 1]);
        update.extend_from_slice(&320u16.to_be_bytes());
        update.extend_from_slice(&240u16.to_be_bytes());
        update.extend_from_slice(&0u16.to_be_bytes());
        update.extend_from_slice(&0u16.to_be_bytes());
        update.extend_from_slice(&ENCODING_POINTER_POS.to_be_bytes());
        stream.write_all(&update).unwrap();

        let mut invalid = Vec::new();
        invalid.extend_from_slice(&[0, 0, 0, 1]);
        invalid.extend_from_slice(&320u16.to_be_bytes());
        invalid.extend_from_slice(&240u16.to_be_bytes());
        invalid.extend_from_slice(&1u16.to_be_bytes());
        invalid.extend_from_slice(&0u16.to_be_bytes());
        invalid.extend_from_slice(&ENCODING_POINTER_POS.to_be_bytes());
        stream.write_all(&invalid).unwrap();
    });

    let stream = TcpStream::connect(address).unwrap();
    let mut connection = RfbConnection::new_stream(
        stream,
        Duration::from_secs(2),
        DecodeLimits::default(),
        VncSecurityPolicy::AllowNone,
        8,
        None,
        None,
    )
    .unwrap();
    connection.width = 800;
    connection.height = 600;
    connection.framebuffer = Framebuffer::new(800, 600, &DecodeLimits::default())
        .unwrap()
        .shared();

    match connection.read_server_message().unwrap() {
        ServerMessage::FramebufferUpdate {
            rects,
            cursor,
            pointer_pos,
        } => {
            assert!(rects.is_empty());
            assert!(cursor.is_none());
            assert_eq!(pointer_pos, Some(DecodedPointerPosition { x: 320, y: 240 }));
        }
        other => panic!("expected pointer position update, got {other:?}"),
    }
    assert!(connection.read_server_message().is_err());
    server.join().unwrap();
}

#[test]
fn decodes_visible_and_hidden_x_cursor_pseudo_encodings() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let address = listener.local_addr().unwrap();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();

        let mut visible = Vec::new();
        visible.extend_from_slice(&[0, 0, 0, 1]);
        visible.extend_from_slice(&1u16.to_be_bytes());
        visible.extend_from_slice(&0u16.to_be_bytes());
        visible.extend_from_slice(&2u16.to_be_bytes());
        visible.extend_from_slice(&1u16.to_be_bytes());
        visible.extend_from_slice(&ENCODING_X_CURSOR.to_be_bytes());
        visible.extend_from_slice(&[1, 2, 3, 4, 5, 6]);
        visible.extend_from_slice(&[0b1000_0000]);
        visible.extend_from_slice(&[0b1100_0000]);
        stream.write_all(&visible).unwrap();

        let mut hidden = Vec::new();
        hidden.extend_from_slice(&[0, 0, 0, 1]);
        hidden.extend_from_slice(&0u16.to_be_bytes());
        hidden.extend_from_slice(&0u16.to_be_bytes());
        hidden.extend_from_slice(&0u16.to_be_bytes());
        hidden.extend_from_slice(&0u16.to_be_bytes());
        hidden.extend_from_slice(&ENCODING_X_CURSOR.to_be_bytes());
        stream.write_all(&hidden).unwrap();
    });

    let stream = TcpStream::connect(address).unwrap();
    let mut connection = RfbConnection::new_stream(
        stream,
        Duration::from_secs(2),
        DecodeLimits::default(),
        VncSecurityPolicy::AllowNone,
        8,
        None,
        None,
    )
    .unwrap();
    connection.width = 800;
    connection.height = 600;
    connection.framebuffer = Framebuffer::new(800, 600, &DecodeLimits::default())
        .unwrap()
        .shared();

    match connection.read_server_message().unwrap() {
        ServerMessage::FramebufferUpdate {
            rects,
            cursor: Some(cursor),
            pointer_pos,
        } => {
            assert!(rects.is_empty());
            assert!(pointer_pos.is_none());
            assert_eq!((cursor.hotspot_x, cursor.hotspot_y), (1, 0));
            assert_eq!((cursor.width, cursor.height), (2, 1));
            assert_eq!(cursor.rgba, vec![1, 2, 3, 255, 4, 5, 6, 255]);
        }
        other => panic!("expected visible X cursor update, got {other:?}"),
    }

    match connection.read_server_message().unwrap() {
        ServerMessage::FramebufferUpdate {
            rects,
            cursor: Some(cursor),
            pointer_pos,
        } => {
            assert!(rects.is_empty());
            assert!(pointer_pos.is_none());
            assert_eq!((cursor.width, cursor.height), (0, 0));
            assert!(cursor.rgba.is_empty());
        }
        other => panic!("expected hidden X cursor update, got {other:?}"),
    }

    server.join().unwrap();
}
