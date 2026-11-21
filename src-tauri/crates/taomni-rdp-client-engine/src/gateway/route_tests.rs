use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use rustls::pki_types::{CertificateDer, PrivatePkcs8KeyDer};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};
use tokio_rustls::TlsAcceptor;

use crate::{
    GatewayOpt,
    transport::{RdpConnector, RdpTransport},
};

use super::tunnel::open_tunnel_with_routes;

fn route(stream: DuplexStream) -> RdpConnector {
    let stream = Mutex::new(Some(stream));
    Arc::new(move || {
        let stream = stream.lock().unwrap().take().expect("route used once");
        Box::pin(async move { Ok(RdpTransport::new(stream, "127.0.0.1:4481".parse().unwrap())) })
    })
}

async fn observe_channel(accept: TlsAcceptor, stream: DuplexStream, method: &str) {
    let mut stream = accept.accept(stream).await.unwrap();
    let mut header = Vec::new();
    while !header.ends_with(b"\r\n\r\n") {
        assert!(header.len() < 8192, "unterminated gateway headers");
        header.push(stream.read_u8().await.unwrap());
    }
    let header = String::from_utf8(header).unwrap();
    assert!(header.starts_with(&format!("{method} /rpc/rpcproxy.dll?gateway.test:3388 ")));
    assert!(header.contains("\r\nAuthorization: Basic "));
    stream
        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
        .await
        .unwrap();
    assert_eq!(stream.read_u8().await.unwrap(), 5, "first RTS PDU version");
    stream.shutdown().await.unwrap();
}

#[tokio::test]
async fn opens_tls_on_both_supplied_gateway_channels() {
    let cert = rcgen::generate_simple_self_signed(vec!["gateway.test".to_owned()]).unwrap();
    let fingerprint = hex::encode(Sha256::digest(cert.cert.der().as_ref()));
    let server = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_no_client_auth()
    .with_single_cert(
        vec![CertificateDer::from(cert.cert.der().to_vec())],
        PrivatePkcs8KeyDer::from(cert.signing_key.serialize_der()).into(),
    )
    .unwrap();
    let accept = TlsAcceptor::from(Arc::new(server));
    let (client_in, server_in) = tokio::io::duplex(16 * 1024);
    let (client_out, server_out) = tokio::io::duplex(16 * 1024);
    let (inbound, outbound) = (route(client_in), route(client_out));
    let gateway = GatewayOpt {
        host: "gateway.test".into(),
        port: 443,
        username: "qa".into(),
        password: Some("fixture".into()),
        auth: "basic".into(),
        use_session_creds: false,
        certificate_fingerprint: Some(fingerprint),
    };
    tokio::time::timeout(Duration::from_secs(5), async {
        let (result, (), ()) = tokio::join!(
            open_tunnel_with_routes(&gateway, "desktop.test", 3389, &inbound, &outbound),
            observe_channel(accept.clone(), server_in, "RPC_IN_DATA"),
            observe_channel(accept, server_out, "RPC_OUT_DATA"),
        );
        assert!(
            result.is_err(),
            "fixture stops after observing the two channels"
        );
    })
    .await
    .unwrap();
}
