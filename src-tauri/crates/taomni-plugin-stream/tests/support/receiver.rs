//! GitHub-only process fixture. Descriptors arrive through a private stdin pipe,
//! never through command arguments, environment variables or diagnostic logs.
use std::io;

use sha2::{Digest, Sha256};
use taomni_plugin_api::BinaryRef;
use taomni_plugin_stream::{CancellationToken, TransferLimits, receive};

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let descriptor: BinaryRef = serde_json::from_reader(io::stdin()).expect("descriptor input");
    let bytes = receive(
        &descriptor,
        TransferLimits::default(),
        &CancellationToken::new(),
    )
    .await
    .unwrap_or_else(|error| panic!("receive failed: {} {}", error.code, error.message));
    let hash: String = Sha256::digest(&bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    println!("{} {hash}", bytes.len());
}
