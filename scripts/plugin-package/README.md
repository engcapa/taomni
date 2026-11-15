# Official plugin package tooling

This standalone Rust tool creates a ZIP `.taomni-plugin`, exact internal
`SHA256SUMS`, detached `.minisig`, a public `module.json`, external checksum and
`provenance.json`. It reads the same production public key as the core updater
from `src-tauri/tauri.conf.json`; the CLI has no key override.

Build the module host for its target first. Prepare one payload directory with
`module.json`, the declared `entry.host`, `entry.frontend` and all other runtime
files. Windows manifests must name the actual `.exe`. The packager rejects
symlinks, reserved paths, case aliases, missing entries and output reuse, and
sets the host ZIP mode to executable. Complete system signing/notarization of
host code before packaging; a Minisign envelope does not establish OS trust.

Compile before injecting secrets:

```bash
cargo build --manifest-path scripts/plugin-package/Cargo.toml --release --locked
```

Only the signing process receives `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` through its environment, preferably from
GitHub secrets. The tool accepts Tauri's base64-encoded Minisign secret or a raw
Minisign envelope. Never put either secret in arguments or a payload directory.

```bash
scripts/plugin-package/target/release/taomni-plugin-package \
  --payload path/to/prepared-payload --platform linux-x86_64 \
  --output path/to/empty-output --source-sha <full-source-commit>
```

It uses upstream `minisign` ED/BLAKE2b streaming signatures, then independently
verifies the result with `minisign-verify` against the pinned key. The signed
trusted comment binds `id`, `version`, `platform`, `coreApiVersion` and archive
`sha256`. This supports packages larger than the legacy Ed 32 MiB limit.
No private-key file is created or published. Failures leave no completed package.

`qa-modular-packages.yml` builds the official hello host on four release targets
without secrets, then uses a fresh runner and tools from `github.workflow_sha`
to sign inert, allowlisted payloads. Candidate source must be reachable from a
repository-owned branch; fork PRs cannot request signatures. It uploads QA
artifacts only, named `qa-modular-package-<platform>-<invocation-key-or-run-id>`,
retained for 14 days. It does not create or update a GitHub Release.

`qa-ui-auto-platforms` automatically requests these artifacts for native
`TC-MODULES-007`. The fixture requires exact source SHA, platform, identity and
bytes; the production app must still validate the signature through Settings.
It never installs a QA public key. A missing artifact or key fails the run.
The case retains signed inputs and `official-module-observations.jsonl` under
the normal shard artifact, including restart integrity and uninstall results.
Browser `TC-MODULES-006` continues to reject explicitly.

For production release, upload immutable versioned `.taomni-plugin` and
`.minisig` assets, then publish the signed `modules.json` last using the existing
`compose-modules-manifest.mjs` sequence/atomic-publication flow. A single module
release need not rebuild the core. This QA workflow grants no production
publication permission and does not close G1/G2/G3, system signing or migration
acceptance. Installed packages live under the application data directory's
`plugins/<slug>/versions/<version>/`; `.taomni-trust` retains the original signed
archive for restart/enable/rollback verification. `active.json` identifies the
active and previous immutable versions; data is owned separately.

Pure local validation:

```bash
cargo test --manifest-path scripts/plugin-package/Cargo.toml --lib --locked
cargo fmt --manifest-path scripts/plugin-package/Cargo.toml -- --check
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m unittest test_module_signed_archive
```

UI, actual host processes, app restarts and installation execute only on GitHub
runners. A passing pure unit test cannot replace a signed native success run.
