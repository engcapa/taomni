use crate::mail::limits::DEFAULT_TIMEOUT_SECS;
use crate::terminal::network::NetworkSettings;
use std::time::Duration;

/// Own the async forwarder for exactly as long as the blocking OAuth client.
/// A private runtime also works on plain refresh-worker threads.
pub(in crate::mail) struct OAuthHttpClient {
    client: reqwest::blocking::Client,
    endpoint: reqwest::Url,
    host_header: String,
    forward: Option<tokio::task::JoinHandle<()>>,
    runtime: Option<tokio::runtime::Runtime>,
}

impl OAuthHttpClient {
    pub(in crate::mail) fn post(&self) -> reqwest::blocking::RequestBuilder {
        self.client
            .post(self.endpoint.clone())
            .header(reqwest::header::HOST, &self.host_header)
    }
}

impl Drop for OAuthHttpClient {
    fn drop(&mut self) {
        if let Some(forward) = self.forward.take() {
            forward.abort();
        }
        if let Some(runtime) = self.runtime.take() {
            runtime.shutdown_background();
        }
    }
}

pub(super) fn client(
    network: Option<&NetworkSettings>,
    endpoint: &str,
) -> Result<OAuthHttpClient, String> {
    let url = reqwest::Url::parse(endpoint).map_err(|_| "Invalid OAuth endpoint")?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("OAuth endpoint must use HTTP or HTTPS".into());
    }
    let mut request_url = url.clone();
    let host_header = url[url::Position::BeforeHost..url::Position::AfterPort].to_owned();
    let host = url.host_str().ok_or("OAuth endpoint has no host")?;
    let resolved;
    let network = if let Some(net) = network.filter(|n| n.proxy_kind == "system") {
        resolved = crate::terminal::network::proxy_selection::resolve_system(net, host)?;
        Some(&resolved)
    } else {
        network
    };
    let mut builder = reqwest::blocking::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(DEFAULT_TIMEOUT_SECS));
    let mut runtime = None;
    let mut forward = None;
    if let Some(net) = network {
        match net.proxy_kind.as_str() {
            "" | "none" => {}
            "http" | "socks5" => {
                let scheme = if net.proxy_kind == "socks5" {
                    "socks5h"
                } else {
                    "http"
                };
                let host = if net.proxy_host.contains(':') {
                    format!("[{}]", net.proxy_host)
                } else {
                    net.proxy_host.clone()
                };
                let mut proxy =
                    reqwest::Proxy::all(format!("{scheme}://{host}:{}", net.proxy_port))
                        .map_err(|_| "Invalid OAuth proxy configuration")?;
                if !net.proxy_user.is_empty() {
                    proxy = proxy.basic_auth(&net.proxy_user, &net.proxy_pass);
                }
                builder = builder.proxy(proxy);
            }
            "ssh-tunnel" => {
                let rt = tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(1)
                    .enable_all()
                    .build()
                    .map_err(|e| format!("OAuth SSH transport runtime failed: {e}"))?;
                let port = url
                    .port_or_known_default()
                    .ok_or("OAuth endpoint port is missing")?;
                let tunnel = rt
                    .block_on(async {
                        tokio::time::timeout(
                            Duration::from_secs(DEFAULT_TIMEOUT_SECS),
                            crate::database::forward::start(host.to_owned(), port, net.clone()),
                        )
                        .await
                    })
                    .map_err(|_| "OAuth SSH connection timed out")??;
                // Explicit URL ports override DNS override ports in reqwest.
                // Change only the dial port, preserving the original TLS name
                // and supplying the original HTTP authority in post().
                request_url
                    .set_port(Some(tunnel.local_port))
                    .map_err(|_| "Invalid OAuth dial port")?;
                builder = builder.resolve(host, ([127, 0, 0, 1], tunnel.local_port).into());
                forward = Some(tunnel.task);
                runtime = Some(rt);
            }
            _ => return Err("OAuth proxy selection has not been resolved".into()),
        }
    }
    let result = builder
        .build()
        .map_err(|e| format!("OAuth HTTP client failed: {e}"));
    match result {
        Ok(client) => Ok(OAuthHttpClient {
            client,
            endpoint: request_url,
            host_header,
            forward,
            runtime,
        }),
        Err(error) => {
            if let Some(task) = forward {
                task.abort();
            }
            if let Some(rt) = runtime {
                rt.shutdown_background();
            }
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn http_proxy_routes_oauth_to_configured_proxy_without_resolving_endpoint() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut data = [0; 4096];
            let count = stream.read(&mut data).unwrap();
            let request = String::from_utf8_lossy(&data[..count]).to_string();
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                .unwrap();
            request
        });
        let network = NetworkSettings {
            proxy_kind: "http".into(),
            proxy_host: "127.0.0.1".into(),
            proxy_port: port,
            ..Default::default()
        };
        let endpoint = "http://oauth.invalid/token";
        let response = client(Some(&network), endpoint)
            .unwrap()
            .post()
            .send()
            .unwrap();
        assert_eq!(response.text().unwrap(), "ok");
        assert!(
            server
                .join()
                .unwrap()
                .starts_with("POST http://oauth.invalid/token HTTP/1.1\r\n")
        );
    }

    #[test]
    fn unresolved_application_selection_fails_closed() {
        let network = NetworkSettings {
            proxy_kind: "app".into(),
            ..Default::default()
        };
        assert!(client(Some(&network), "https://oauth.invalid/token").is_err());
    }
}
