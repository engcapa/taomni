# Version 1 backup fixtures

Fixed synthetic archives independently encoded by `scripts/backup-compat-fixtures.py`,
using the protocol at base commit `65a822785a86c52671983076cd0a244c59626260`.
These contain no user data or secrets. The encrypted samples use the public fixture
password `compat-password`. SHA-256 values are in `sha256.json`.

All envelopes contain a version-1 manifest, `databases/notes.db` with a
`legacy_marker` table, and `configs/tunnels.json`. They intentionally omit the
optional provenance field and all local settings metadata. Unit tests inspect,
stage and apply each fixed archive, verify its payloads, and ensure its original
bytes remain unchanged. Native QA inspects the same files through the UI.

Tests never regenerate these files. Regeneration requires Python's
`argon2-cffi` and `cryptography`; those packages are not runtime/QA dependencies.
