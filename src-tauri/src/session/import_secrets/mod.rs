// Recovery of saved secrets from third-party SSH/terminal apps.
//
// Two recovery shapes are supported:
//
//   1. Encrypted-blob: the tool ships its own KDF + symmetric crypto over
//      a config blob. Tabby uses PBKDF2-SHA512 + AES-256-CBC; other tools
//      will use different parameters. Each tool gets its own decoder
//      module which calls into `crypto`.
//
//   2. OS keychain: the tool stores per-secret entries in Credential
//      Manager / Keychain Services / Secret Service. The lookup primitive
//      is identical across tools — only the (service, account) naming
//      differs — so every importer reuses `keychain::keychain_lookup_batch`.
//
// Tabby is the only consumer wired in this PR. Adding the next tool is:
// one decoder file, one Tauri command, plus (service, account) builders
// in the frontend.

pub mod crypto;
pub mod keychain;
pub mod tabby;
