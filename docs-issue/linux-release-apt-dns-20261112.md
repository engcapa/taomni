# Linux release dependency installation failure

## Evidence

- Run: https://github.com/engcapa/taomni/actions/runs/43049067567
- Linux job: https://github.com/engcapa/taomni/actions/runs/43049067567/job/130622768001
- Tag / commit: `v0.5.8` / `4152a1e622dab15728d788aa383c792c32a33210`.
- `Install Linux bundle dependencies` ran from 2026-11-11 15:34:12 UTC
  until 16:55:51 UTC and failed with exit code 100. Compilation never started.
- The runner's `mirror+file:/etc/apt/apt-mirrors.txt` repository repeatedly
  reported `Temporary failure resolving 'azure.archive.ubuntu.com'`.
- At 15:37:40 UTC, `apt-get update` warned that indexes failed to download
  and old indexes were used, but returned success. Package installation then
  spent another 78 minutes attempting downloads through the failing mirrors.
- Windows and both macOS builds passed; the final publishing job was skipped
  because it requires all builders to pass.
- Comparison: the successful v0.5.7 run
  https://github.com/engcapa/taomni/actions/runs/42491697655 used the identical
  `release.yml` and runner image `20261101.347.1`. Its same Azure mirror fetched
  30 MB of indexes in 3 seconds and 82.4 MB of packages in 13 seconds; the
  dependency step finished in 52 seconds. The v0.5.8 failure is consistent with
  a runner/mirror DNS outage, not a changed dependency command or runner image.
  Logs do not establish the underlying DNS service or network fault.

## Change

`scripts/install-linux-release-deps.sh` uses explicit official HTTPS Ubuntu
repositories for Jammy, updates, backports and security. Both APT commands use
the same temporary source list and fresh index directory, excluding inherited
runner sources and their cached mirror URLs. Repository signatures remain
required through the Ubuntu archive keyring. The runner's source configuration
is not modified.

Index errors now fail the step before installation. APT retries downloads three
times with 30-second HTTP/HTTPS timeouts; the workflow bounds the entire step
to 20 minutes. Temporary indexes are cleaned on normal success or failure.
Ubuntu 22.04, the glibc baseline, dependency list and PipeWire build are preserved.

## Validation

- Execute `node --test scripts/install-linux-release-deps.test.mjs
  scripts/resolve-release-build.test.mjs scripts/release-workflow.test.mjs
  scripts/sherpa-onnx-cache.test.mjs scripts/compose-updater-manifest.test.mjs
  scripts/verify-updater-signatures.test.mjs` using Node.js 22.
- Run `bash -n scripts/install-linux-release-deps.sh` and `pnpm check:refactor`.
- Local results: Node.js 22 tests passed 39 cases, with two existing opt-in
  Windows native cache tests skipped. Shell syntax and refactor checks passed
  (the latter using pnpm 10).
- The new tests execute the shell script with APT mocked, checking official
  sources, fresh/shared indexes, unchanged dependencies, failure propagation,
  cleanup and the workflow time limit. They run in the release planning job.
- Real Linux APT installation and a complete release build still require CI
  verification; the local Windows environment has no usable Linux container or
  WSL distribution. A general runner DNS outage can still fail official hosts;
  this change avoids the inherited mirror path and stops such failures promptly.
- Rerunning the old tag's workflow uses its old configuration. Verify the fix
  from a ref containing these changes; an empty-tag manual run builds artifacts
  without publishing a release.
