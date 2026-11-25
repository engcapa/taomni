# Official host SDK

`serve_stdio` owns the control reader independently from one bounded business
worker. A waiting `Operation::fixed_key` does not block heartbeat, cancellation
or `vault/revoke` processing. Configure compiled plugin identity, commands,
permissions and required service versions through `HostConfig`.

The core supplies an authenticated per-spawn `hostInstance` and an admitted
top-level operation context. A service-enabled host rejects generic renderer
invokes without that context. Handshake `requestIdMode: monotonic-v1` explicitly
negotiates strictly increasing `core/<instance>/<sequence>` and
`host/<instance>/<sequence>` IDs, with constant-size receive watermarks. Missing
echo keeps the legacy bounded ledger; scoped caller IDs may then retain their
operation UUID. Neither direction uses the authentication token in its IDs.
Replayed commands and unknown responses fail closed; one known response arriving
after cancellation can be discarded. Pending plus unanswered cancelled requests
share an eight-request bound and one atomic reply/retirement owner. Completed
history consumes no capacity; checked counters never wrap or reuse an ID.

Use `Operation::fixed_key` and `OperationKey::with_key` inside the business
operation. Missing remains `None`; this API never silently creates a key. The
core still authorizes the exact owner, key ID, operation class and manifest.
An operation key cannot outlive its operation, be cloned or serialized; its
Debug is redacted. Read responses deserialize directly from zeroizing raw JSON
into `FixedKeyResult`, without a generic result Value. Consumed read scratch and
raw frames are cleared before releasing a key reply to the business worker.
Each key guard drops its key, and worker completion clears remaining slots
before reporting normal, error, panic or cancellation results.

Cancellation marks the operation immediately; trusted handlers must check it
between long operations and while waiting for resources. A revoke is not
acknowledged until the business worker has stopped and cleared its keys. The
core's process containment and deadline remain necessary for uncooperative or
stuck handlers. This SDK is not a third-party sandbox or proof that every OS
memory copy is unrecoverable.

Local validation runs `cargo test -p taomni-plugin-sdk --lib` only. Real pipes,
process replacement, liveness, deadlines and actual Vault access run through
`qa-modular-upgrade.yml` on GitHub. `host-gate-services` is a protocol fixture,
not an installed or migrated MFA plugin. Production registry/bootstrap factory,
Vault lifecycle coordination, profile leases and business migration are still
required before TASK-025-D/E and MFA delivery can be accepted.
