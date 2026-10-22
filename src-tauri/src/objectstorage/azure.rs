//! Azure Blob engine: raw HTTPS over the shared reqwest client + quick-xml,
//! with a hand-written Shared Key signer (the official SDK only supports Entra
//! ID natively). SAS auth appends the token to the URL instead of signing.
//! Verified against Azurite. Mirrors the S3 client's operation surface so the
//! command layer can dispatch on `OssHandle` uniformly.

mod authentication;

mod client;

mod metadata;

mod catalog;

mod objects;

mod transfers;

mod xml_model;

#[cfg(test)]
mod tests;

pub use authentication::{
    AzureAuth, acquire_bearer_token, azure_base_url, decode_account_key, parse_connection_string,
};

pub use client::AzureClient;
