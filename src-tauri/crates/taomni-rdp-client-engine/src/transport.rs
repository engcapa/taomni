pub use taomni_rdp_client_api::transport::{RdpConnector, RdpTransport};

#[cfg(test)]
pub(crate) fn direct_connector(host: String, port: u16) -> RdpConnector {
    std::sync::Arc::new(move || {
        let host = host.clone();
        Box::pin(async move {
            let stream = tokio::net::TcpStream::connect((host.as_str(), port))
                .await
                .map_err(|error| error.to_string())?;
            let local_addr = stream.local_addr().map_err(|error| error.to_string())?;
            Ok(RdpTransport::new(stream, local_addr))
        })
    })
}
