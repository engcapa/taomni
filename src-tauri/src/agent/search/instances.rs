/// Public SearXNG instances to probe on startup.
/// Ordered by historical reliability. NewMob probes all concurrently and picks the fastest.
pub const PUBLIC_INSTANCES: &[&str] = &[
    "https://searx.be",
    "https://search.inetol.net",
    "https://searxng.world",
    "https://paulgo.io",
    "https://search.bus-hit.me",
];

/// Probe all instances concurrently with a 2s timeout, return the first that responds 200.
pub async fn probe_best_instance(client: &reqwest::Client) -> Option<String> {
    use futures::future::select_ok;
    use std::time::Duration;
    use tokio::time::timeout;

    let futures: Vec<_> = PUBLIC_INSTANCES.iter().map(|&url| {
        let client = client.clone();
        let url = url.to_string();
        Box::pin(async move {
            let probe_url = format!("{}/search?q=test&format=json", url);
            let result = timeout(
                Duration::from_secs(2),
                client.get(&probe_url).send(),
            ).await;
            match result {
                Ok(Ok(resp)) if resp.status().is_success() => Ok(url),
                _ => Err(format!("unreachable: {}", url)),
            }
        })
    }).collect();

    select_ok(futures).await.ok().map(|(url, _)| url)
}
