//! Disposable subprocess for hosted crash/restart contracts. This executable
//! is never bundled with Taomni and never runs as part of local unit tests.

use std::path::PathBuf;
use std::time::Duration;

use sha2::{Digest, Sha256};
use taomni_download_gates::download::*;

#[tokio::main]
async fn main() {
    let mut arguments = std::env::args().skip(1);
    let directory = PathBuf::from(arguments.next().expect("isolated staging root"));
    let url = arguments.next().expect("runner-local fixture URL");
    assert!(arguments.next().is_none());
    let body = b"verified module package bytes";
    let request = DownloadRequest {
        id: "package".into(),
        url,
        partial_path: directory.join("module.part"),
        completed_path: directory.join("module.pkg"),
        expected_total: Some(body.len() as u64),
        expected_sha256: Some(
            Sha256::digest(body)
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect(),
        ),
        proxy: ProxyRoute::NoProxy,
    };
    let manager = DownloadManager::persistent(
        HttpDownloadService::new(&ProxyRoute::NoProxy).unwrap(),
        directory.clone(),
    );
    drop(manager.start(request).await.unwrap());
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            if manager.snapshot("package").await.unwrap().downloaded >= 6
                && std::fs::metadata(directory.join("module.part"))
                    .is_ok_and(|metadata| metadata.len() >= 6)
            {
                std::fs::write(directory.join("worker-ready"), b"6").unwrap();
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    std::future::pending::<()>().await;
}
