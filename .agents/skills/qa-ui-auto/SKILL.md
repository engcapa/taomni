---
name: qa-ui-auto
description: "Efficient functional, UI and native testing for the whole Taomni app: choose focused cases, diagnose test/build cost, run browser or isolated native checks, maintain cases/catalogs and inspect real evidence. IDEA visual/interaction comparison is an optional specialization."
---

# Taomni App Verification

Prove the requested behavior with the smallest sufficient set of checks across
Taomni modules. Keep product correctness, UI fidelity, test cost and app
performance distinct. Read conditional references only when needed.

Requests calling the repository's app testing workflow `qa-test-auto` use this
skill; `qa-ui-auto` remains the canonical installed name and CLI.

## Choose The Work

| Request | Resource |
|---|---|
| Develop/verify a feature, or tests/builds are slow | [efficient-verification.md](references/efficient-verification.md) |
| Refactor existing behavior, shared UI/state, or investigate a regression | [regression-protection.md](references/regression-protection.md) |
| Run known cases | Read their assertions and requirements, run the selected mode directly; no mandatory audit/plan/status cycle |
| Author YAML or controls | [authoring.md](references/authoring.md) and relevant [verb-catalog.md](references/verb-catalog.md) entries |
| Launch native QA | [native-testing.md](references/native-testing.md) |
| Claim current coverage, combine reports or release | [verification.md](references/verification.md) |
| Compare IDEA UI/interaction | Also [idea-visual-interaction.md](references/idea-visual-interaction.md) |
| Substantial skill/runner refactor or requested skill E2E | [skill-e2e-evaluation.md](references/skill-e2e-evaluation.md) |
| Change only skill prose or test tools | Validate affected instructions/tools; app compilation only if changed execution behavior requires it |

Do not turn routine feature work into a release checklist or full capability audit.

## Default Execution Policy

1. Identify intended changes and affected behavior that must remain. Select the
   union of target acceptance and retained-behavior checks, tracing shared
   consumers beyond feature labels. Use [regression protection](references/regression-protection.md)
   for behavior refactors; establish the relevant pre-change baseline and reuse
   meaningful tests, not tests that mirror implementation details.
2. Iterate with focused unit/mounted tests and browser UI. Native-only defects
   need an early distinguishing probe, not a native rebuild after every edit.
3. Stabilize related code/tests, build QA once per required input/configuration,
   then run selected native scenarios. Reuse matching builds and browser workers.
   Keep native sessions isolated and sequential.
4. Complete target acceptance, affected retained-behavior and current-platform checks.
   Regressions introduced by this change are part of this task, including other
   consumers. Repeat/expand only
   for a relevant change, failure recovery or unresolved assertion. Stop when the
   required checks pass; integration/release gates apply only in that scope.

For desktop delivery, pure renderer changes use browser feedback during iteration
and a focused current-WebView visual smoke at completion. Explicit browser-only
or skill/tool verification stays within that scope and records packaged-WebView
behavior as unverified; it does not inherit an app build requirement.
IPC, disk, processes, dialogs,
clipboard, IME, shortcuts and windows need native evidence at affected boundaries.
Real browser service bridges do not become native evidence. UI and interaction
can be redesigned; test the new target while preserving retained capabilities.

## Commands

From repository root, set `PYTHONPATH=.agents/skills/qa-ui-auto/scripts`.
PowerShell: `$env:PYTHONPATH = ".agents/skills/qa-ui-auto/scripts"`.

```bash
python -m qa_ui_auto plan --diff HEAD
python -m qa_ui_auto plan --case TC-001 --platform Windows --json
python -m qa_ui_auto run --mode browser --filter TC-001 --require-pass
python .agents/skills/qa-ui-auto/scripts/native_build.py --check
python -m qa_ui_auto costs --reports qa-ui-auto-report --case TC-001
python -m qa_ui_auto status --case TC-001 --platform Windows --reports qa-ui-auto-report --json
```

Read the selected YAML's actual `id` and the config's URL before executing.
`--mode browser` selects the runner; it does not change a native-oriented config's
URL. For browser-only work, [qa-ui-auto.config.browser.yaml](assets/qa-ui-auto.config.browser.yaml)
is a minimal config to pass via `--config`; verify its Vite server serves this
checkout. It requires no SSH/provider/driver setup.

Use actual IDs/platforms. `plan/status --case` accept exact IDs, repeatable;
unknown or filtered-out IDs fail. `--feature`, `--tag` and `--case` explicitly
limit scope, not prove all affected coverage. `plan` recommends candidates:
shared/unmapped runtime edits broaden it, so inspect assertions before running
the list. Generated commands retain selected `--cases` and `--config`; text output
quotes arguments for PowerShell on Windows and a POSIX shell elsewhere. QA prose
changes alone do not plan the product suite. `--tag smoke` is a quick slice.

`native_build.py --check` does not compile or launch: exit 0 reusable, 1 build
needed, 2 check error. It reports changed input categories and prior build time.
Normal invocation builds or reuses; `--force` is for diagnosed cache trouble.

`costs` reads recorded timings, including failures/skips and repeated attempts,
grouped by case/mode/OS. It never certifies coverage/freshness. Run wall time,
case sums and phase/step times overlap; do not add them. Missing evidence stays
explicit. Test duration and DOM timing are not key-to-screen performance.

Long-running jobs (Vite, native builds, suite sweeps) must be started detached
with `scripts/background_job.py`; never leave a resident process in a foreground
tool call because the harness waits for the whole process tree and the session
freezes until it exits (observed: a 101-minute stall on Windows).

```bash
python .agents/skills/qa-ui-auto/scripts/background_job.py start --name vite \
  --log qa-ui-auto-report/_local/vite.log \
  --env DEV_PROXY_ALLOW_PRIVATE=1 -- pnpm dev
python .agents/skills/qa-ui-auto/scripts/background_job.py status \
  --state qa-ui-auto-report/_local/vite.log.job.json --tail 20
python .agents/skills/qa-ui-auto/scripts/background_job.py wait \
  --state qa-ui-auto-report/_local/vite.log.job.json --timeout 3600
```

Browser SSH/SFTP/RDP cases reach the configured servers through the Vite dev
proxy. `pnpm dev` already defaults `DEV_PROXY_ALLOW_PRIVATE=1` from
`vite-plugins/devProxyDefaults.ts`; the explicit `--env` keeps the documented
start command self-contained and works when Vite is launched another way.
Never drop the flag on a server started by hand: without it the proxy blocks
private targets and the SSH/SFTP cases fail with an explicit block reason.

`wait` propagates the job's exit code. Suite output is line-buffered when
redirected, so logs and `run-*/summary.json` show live progress. Keep a verified
Vite server resident across runs; on machines with eight or more cores a browser
sweep may use `--workers 6`, while native stays sequential and exclusive for
performance gates. Windows detaches through the WMI service; POSIX uses a new
session (`setsid`).

### Local SSH and MySQL services

The runner can own disposable Docker services for cases that declare
`ssh_required`, `sftp_required`, or `mysql_required`. Enable them independently
in the local config copied from
`.agents/skills/qa-ui-auto/assets/qa-ui-auto.config.example.yaml`:

```yaml
fixtures:
  start_local_sshd: true
  sshd_port: 2222
  sshd_user: testuser
  sshd_password: ${env.QA_SSH_PASSWORD}
  start_local_mysql: true
  mysql_port: 3306
  mysql_user: test
  mysql_password: ${env.TAOMNI_TEST_MYSQL_PASSWORD}
  mysql_root_password: ${env.TAOMNI_TEST_MYSQL_ROOT_PASSWORD}
  mysql_database: test
```

When enabled, `qa_ui_auto` starts the services once before the selected browser
workers or native harness and removes them in a `finally`-equivalent cleanup.
SSH uses `linuxserver/openssh-server:latest` with host port `2222` mapped to
container port `2222`. MySQL uses `mysql:8.4` with host port `3306` mapped to
container port `3306`. Images and ports can be overridden in the same section.
Passwords are resolved only from environment variables and are never written to
the report.

The SSH readiness check opens the mapped port and verifies an `SSH-` banner.
The MySQL readiness check opens the mapped port and then runs a temporary
MySQL client container against that host port with `SELECT 1`; a raw TCP
listener is not considered sufficient. The runner fails setup explicitly when
Docker, credentials, ports, or the protocol check are unavailable; it does not
silently convert an enabled local service into a skipped/pass case.

`--dry-run` never starts Docker services. For a manual probe using the same
implementation, use:

```bash
python .agents/skills/qa-ui-auto/scripts/fixtures.py start-all \
  --port 2222 --user testuser \
  --password "$QA_SSH_PASSWORD" \
  --root-password "$TAOMNI_TEST_MYSQL_ROOT_PASSWORD"
python .agents/skills/qa-ui-auto/scripts/fixtures.py stop
```

The manual command's credentials are disposable test values only; prefer
environment variables or workspace secrets and never commit them.

## Execution And Evidence

- Native uses the separately built `com.taomni.app.qa`, isolated data/config/cache
  and disposable projects. Never rename production binaries or reset personal data.
- Select browser/native explicitly; `run` otherwise defaults to browser.
  `--dry-run` proves syntax/verbs only; `--require-pass` fails selected skips.
  Native is sequential; browser `--workers N` reuses processes with fresh contexts.
- Prepare only selected dependencies. Reuse healthy Vite serving this checkout.
  Mutable fixtures remain isolated; do not bypass source identity for stale builds.
- Inspect summary, matching receipt, source/case/runner/build/config identities
  and selected/pass/fail/skip counts. Preserve failures; an older pass cannot hide
  a newer failure for matching inputs. One qualifying run may cover multiple ACs
  or evidence kinds with separately identified assertions.
- `audit --gate` checks static catalogs; `status --gate` checks reviewed current
  execution in selected scope; `audit --release-evidence` checks the release
  manifest. These are conditional, separate operations.
- Plan Windows/WebView2, Linux/WebKitGTK and macOS/WKWebView compatibility.
  Current-platform completion suffices with others marked unverified. On macOS,
  the isolated `com.taomni.app.qa` debug binary exposes a loopback WKWebView
  WebDriver bridge because Tauri has no upstream macOS adapter; this is native
  execution, while OS-global input, dialogs, permissions and IME still need
  separate OS automation/manual evidence. Keep missing targets and unsupported
  verbs explicit.
- Measure product performance only on affected hot paths with matched
  baseline/candidate conditions and raw samples; keep budgets and slow samples.
- Maintain YAML/covers/controls together when changed. Regenerate the control
  catalog only for control changes; audit once after that batch. Inspection alone
  needs no catalog edits. `--report-dir` and `--keep-runs 0` retain release evidence.

Exploration defaults to 10 minutes or 200 actions in the user's scope. Record
repros and evidence, without automatically authoring cases. Browser tooling:
[playwright-cli.md](references/playwright-cli.md).

Report behavior, scope, checks/outcomes, platform/frontend mode, build/reuse and
remaining gaps. No claimed speedup without matched timings. A simpler tool/runner
may replace a costly path when needed; preserve assertions, isolation and truthful
provenance, and avoid maintaining two conflicting pass systems.
