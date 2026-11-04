# Orchestration hosted validation

## Required scope and honest evidence boundaries

The `orchestration-contracts` supporting job in
`.github/workflows/qa-ui-auto-platforms.yml` runs for `scope=all`, a selected
`TC-ORCH-` case, tags containing `orchestration`, and the scheduled full run.
It is a dependency of `qa-ui-auto-platforms-result`: an installation failure,
missing harness, namespace failure, nonzero worker exit, or receipt mismatch
fails the supporting job and the final aggregate result. A selected but failed
harness is never counted as a successful skip.

The job proves **standalone installed harness** behavior against a controlled
loopback provider: actual process execution, provider protocol, tool result,
assigned Git worktree, marker content/hash, and unchanged source repository.
It does **not** prove dispatch through Taomni's native scheduler or its product
worker adapters, renderer lifecycle, cancellation, worktree/bootstrap ownership,
or cross-platform app behavior. In particular, a green standalone Codex/Pi/
OpenCode/DeepSeek/ZCode canary does not mean its native scheduling path passed.
The explicit fixture-supervised launcher path is covered by a separate authored
native case below; native CLI compatibility still needs actual hosted receipts.

Native app scheduling evidence must additionally launch the matching QA release
binary, create/approve a real run through the product UI/IPC, and correlate its
run/worker identity, assigned cwd, event/request ledger, child lifecycle and
artifact hashes with the fixture receipt. That integration remains a separate
required acceptance path; do not label this canary as native scheduling proof.
Affected feature cases and the complete browser/native `crash-regression` suite
also remain required. See [crash-regressions.md](crash-regressions.md).

## Runtime and installation isolation

1. The existing `qa-runtime` action installs product dependencies with **Node 22
   and pnpm 10**, then runs the scoped UI/store unit tests, TypeScript and
   refactoring contracts. Pure Python fixture unit tests run separately under
   isolated interpreter mode.
2. Only after product checks, `actions/setup-node` selects **Node 24.14.0** for
   the real harnesses. This does not change product manifests, lockfiles or the
   application's required runtime.
3. `install_harnesses.py` installs every catalog entry under
   `$RUNNER_TEMP/orchestration-harnesses`. Each package has its own directory;
   npm identities/integrities and ZCode's exact source commit are checked.
   ZCode uses its own pinned pnpm installation, not the application's pnpm.
   Installation needs network access; actual worker execution does not.
4. No provider secrets are passed to this job. Execution receives disposable
   per-worker HOME/config/state and fixture-only credentials. Raw harness and
   installer stdout/stderr are private diagnostics and are not uploaded.

The pins and researched limits are authoritative in
`qa-ui-auto-tests/fixtures/orchestration/harness_catalog.json`; source-verified
pins are not automatically live-validated pins. All six catalog entries are
required: Claude Code, Codex, Pi, OpenCode, DeepSeek Harness, and ZCode.
The workflow deliberately supplies no harness filter and no soft-failure option.

## Exact GitHub-only execution contract

The workflow runs these commands from the checked-out trusted repository, never
from downloaded package/source directories. The fixture installer creates fresh
empty directories itself. **Do not run these installation or worker commands
locally**; local validation is pure unit tests only.

```bash
python -I "$GITHUB_WORKSPACE/qa-ui-auto-tests/fixtures/orchestration/install_harnesses.py" \
  --root "$RUNNER_TEMP/orchestration-harnesses"

sudo env GITHUB_ACTIONS=true "$(command -v python)" -I \
  "$GITHUB_WORKSPACE/qa-ui-auto-tests/fixtures/orchestration/ci_network.py" \
  --uid "$(id -u)" --gid "$(id -g)" -- \
  "$(command -v python)" -I \
  "$GITHUB_WORKSPACE/qa-ui-auto-tests/fixtures/orchestration/validate_workers.py" \
  --installation "$RUNNER_TEMP/orchestration-harnesses/installation.json" \
  --output "$RUNNER_TEMP/orchestration-evidence" --timeout 120
```

`ci_network.py` requires GitHub/Linux, enters `unshare --net`, verifies that only
`lo` exists, brings loopback up, clears supplemental groups and inherited
credentials/proxies, and drops to the runner's nonroot uid/gid before invoking
the validator. No privileged fallback or outbound interface is allowed.
Namespace tooling/permission failure blocks the job rather than running online.
This is a network boundary, not a filesystem sandbox; the disposable runner and
per-worker files remain necessary. Current namespace interfaces are queried with
`socket.if_nameindex()`, not a potentially parent-mounted `/sys/class/net`.

The fixture-only Codex config keeps `sandbox_mode="workspace-write"` and the
filesystem/PID/IPC/seccomp restrictions, but enables
`sandbox_workspace_write.network_access=true` **only after another mandatory
current-namespace loopback check**. The supervisor's namespace supplies network
isolation: no outbound interface, only the controlled local fixture. This avoids
Codex's redundant inner bwrap loopback address setup (`RTM_NEWADDR EPERM` observed
in hosted run 41745445797). It does not enable host networking, give administrative
capabilities, change application defaults, or prove Codex's independent tool-network
deny mode. An external/missing interface fails before writing this config; no
unisolated fallback, danger-full-access or legacy sandbox bypass is permitted.

The standalone canary uses the supported **Ubuntu 22.04** baseline. On the observed
24.04 hosted kernel, enabling outer-network delegation uncovered a second genuine
bwrap `uid_map` EACCES caused by restricted unprivileged user namespaces. Do not
turn off AppArmor/sysctls or downgrade the worker filesystem sandbox to pass.
For native all-six acceptance, explicitly request `ubuntu-22.04-x11` (or the
supported 22.04 VNC profile) and retain that actual desktop/OS identity in the
selection and receipts. API/crash evidence on 24.04 remains separate; 22.04 worker
evidence must never be labeled 24.04/26.04 sandbox compatibility.

`validate_workers.py` starts the fixture inside the same namespace, allocates
real detached Git worktrees, and calls `worker_bridge.py` for the installed
harnesses. The bridge only launches/validates the real worker; it must not write
the marker or simulate a tool result. Timeouts and process-group cleanup are
bounded. Extra generation requests, incorrect protocol/results, cross-worker
writes, source-repository writes or changed worktree base must fail receipts.

## Native Taomni scheduling lane (wired, execution pending)

`TC-ORCH-WORKER-004` now authors six native UI submissions and explicit approvals,
one per installed harness, then verifies candidates survive a renderer reload.
The CI planner assigns `orchestration-workers` and `release`, separates this case
from normal API/crash/service entries even with `shards=1`, and reuses the same
verified Linux release build artifact. Windows/macOS direct-API and mandatory
browser/native crash-regression lanes are not replaced by this Linux-only case.

The reusable `qa-ui-auto-entry.yml` installs all six pinned harnesses under
`$RUNNER_TEMP/orchestration-native-harnesses` before entering the namespace. Its
`Native Taomni six-worker scheduling in loopback-only namespace` step runs
`ci_network.py --uid ... --gid ... -- <absolute-python> -I ci_native.py
--selection ... --entry ... --report ... --installation ... --native-artifact ...
--adapter-bin ... --adapter-sha256 ... --run-id ... --attempt ...`.
`ci_native.py` supplies a disposable HOME and a narrow PATH including the pinned
Node runtime and preinstalled, SHA-256-checked `tauri-driver` directory. It invokes
the existing `ci_execute.py` identity/artifact/desktop/runner path; no application
rebuild, driver download, real key, or external model endpoint is allowed there.
App, fixture server, and real worker processes share the loopback-only namespace.

The dedicated `orchestration_workers.py` fixture helper seeds explicit supervised
resources using `worker_bridge.py`, literal `{worktree}`/`{state_root}` arguments,
and stdin prompts. Fixtures run before native `create_session`, so profiles and
worker configuration are written before Linux/Windows app startup; macOS reset
also stops its app before fixtures, although this worker case is Linux-only.
The helper does not submit tasks, generate candidates, or write worker markers.
Teardown independently requires six SQLite candidate tasks, frozen resource and
source revisions, one completed host ledger/attempt per task, twelve real LLM
tool/final requests, matching installed-process receipts, candidate DB/disk
hashes, exact worktree UUID owner files and harmless marker diffs. It writes
`native-six-workers.receipt.json` under the case report. Host dispatch counts
(one per task) are explicitly distinct from harness-internal LLM calls (two).
Private HOME/raw harness logs stay in excluded native app-data directories.

Native `orchestration_llm` cases also select `orchestration-contracts`; the existing
Linux Rust contract producer receives `QA_ORCH_CONTRACTS=true` and adds
`orchestration::`, `llm::invocation`, and `go_compatibility_tests` to the same root
libtest OR-filter invocation, not a second root test-binary build.

This is executable wiring plus offline contract validation, **not an executed
native pass**. First hosted evidence must still establish installation/CLI
compatibility and six real native results; the standalone canary is not a
fallback. The six-worker authored case covers happy-path dispatch, tool execution,
artifact ownership and reload persistence; native worker cancellation/forced
termination scenarios and non-Linux real-worker validation remain separate gaps.

## Published artifacts and failure triage

`qa-orchestration-contracts-<run_id>-<attempt>` contains only the catalog,
`installation.json`, `validation.json`, per-harness `*.receipt.json`, and the
fixture's redacted `requests.ndjson`. The job summary states the standalone
scope explicitly. Artifact upload uses `always()` and is not a success signal:
a failed install may produce only the catalog, and an early namespace failure
may produce no validation receipt. The original step/job exit is authoritative.

Check in this order:

- Product unit/type/boundary failure: fix the application contract first.
- Installation: verify the exact runtime, package integrity/identity, source
  commit and expected entrypoint. Never loosen pins to make the job green.
- Isolation: verify `unshare`/`ip` availability and privilege drop. Never remove
  the loopback-only requirement or add provider credentials.
- Harness receipt: correlate protocol/request count, actual tool response,
  terminal event, cwd, marker hash, base commit and source cleanliness. A missing
  or changed upstream CLI flag is a real blocked compatibility result.
- Final aggregate: require `job_results.orchestration-contracts=success` for a
  triggered run and all planned browser/native cases to pass. Native scheduling
  and matching crash-regression evidence are still separate acceptance gates.

No hosted run or native/browser result is asserted by this document. The first
hosted invocation must preserve failures as evidence; source inspection and
local fixture unit tests do not establish that six live harnesses pass.
