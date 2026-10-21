//! S3-family engine: builds and signs requests with rusty-s3 (sans-IO) and
//! executes them over reqwest. Covers AWS S3 and any S3-compatible provider.
//! Service-level ListBuckets — which rusty-s3 has no action for — is signed
//! directly via `rusty_s3::signing::sign`.

mod limits;

mod client;

mod catalog;

mod objects;

mod download;

mod upload;

mod response;

mod metadata;

mod model;

#[cfg(test)]
mod tests;

pub use client::S3Client;
