# Hosted QA UI automation

`.github/workflows/qa-ui-auto-platforms.yml` is independent of the existing E2E,
native and release workflows. Its failures remain visible; it does not add a PR
or release dependency. Runners are Ubuntu 24.04 x64, Windows 2025 x64 and macOS 15
ARM64. Each can run browser and native cases.

## Trigger and select

After the workflow is on the default branch, use **Actions → QA UI Auto Platforms
→ Run workflow**, or:

```sh
gh workflow run qa-ui-auto-platforms.yml --ref YOUR_BRANCH -f scope=smoke
gh workflow run qa-ui-auto-platforms.yml --ref YOUR_BRANCH \
  -f scope=selected -f platforms=linux,windows,macos -f modes=browser,native \
  -f case_ids=TC-012,TC-027
gh workflow run qa-ui-auto-platforms.yml --ref YOUR_BRANCH \
  -f scope=impacted -f base=BASE_SHA -f head=HEAD_SHA
```

GitHub only registers `workflow_dispatch` on the default branch. Publishing the
new file on a feature branch alone is insufficient. Branch validation can use a
temporary branch-specific caller; do not merge that temporary push trigger.

Selectors are exact YAML `id` values, **not filenames**. `selected` unions case
IDs, features and tags; `impacted` unions the conservative diff scope with these
selectors. `all`/`smoke` reject extra selectors. The rename-restore database case
automatically includes its predecessor in the same native invocation. Unknown
IDs, missing diff refs, unsupported explicit scope, changed inputs or selected
skips fail. Pure documentation changes can yield an explicit zero-execution
report. No empty execution is presented as six-platform success.

Reusable caller example (opt in from a separate business flow):

```yaml
jobs:
  qa:
    permissions:
      contents: read
      issues: write
    uses: ./.github/workflows/qa-ui-auto-platforms.yml
    with:
      scope: impacted
      base: YOUR_BASE_SHA
      head: YOUR_HEAD_SHA
      publish_issues: false
```

GitHub checks the maximum permissions of reusable workflows even when an
optional job is skipped. The caller therefore allows `issues: write`; the QA
workflow reduces plan/test/report tokens to `contents: read`. Only the optional
issue publisher receives write permission and it never checks out tested code.
Nightly runs use `all` at 19:17 UTC. Issue sync defaults off; enable its dispatch
input or repository variable `QA_UI_AUTO_PUBLISH_ISSUES=true` for nightly runs.

## Runner-local dependencies

Only selected capabilities are provisioned. Linux owns uniquely named local
Docker SSH/MySQL containers; macOS uses Homebrew OpenSSH and an isolated MySQL
data directory; Windows uses OpenSSH and an isolated MySQL ZIP installation.
Accounts, passwords, keys, ports and databases are disposable within the job VM.
The supervisor runs actual SSH login/PTY/exec, SFTP byte roundtrip and SQL DML
probes before the cases. Secrets are masked and referenced by environment name
in config artifacts. No external server, repository secret or private network
is required. Account/package mutations are limited to CI.

Java downloads are pinned by version and SHA256 in `toolchains.yaml`. JDTLS
performs real LSP initialize; Java 25 projects build online then offline. The
whole debug/test extension server directories are retained. Product semantics
and debugging still require the actual native cases; preparation alone is not
product coverage.

Linux native uses Xvfb, Openbox, DBus and, when required, fcitx5/wbpy. Python/Tk
and XTEST are probed in that session. Windows requires a nonzero interactive
session and an input desktop. macOS requires an Aqua session and uses
WKWebView's own snapshot, without asking for Screen Recording. These images are
WebView captures; they do not establish full desktop capture or OS permission
handling. macOS bridge DOM events do not prove system keyboard/IME interaction.
Unsupported platform/verb combinations appear as gaps in selection/report.

## Evidence and maintenance

Read the run's **qa-ui-auto-platforms-result** summary and download `qa-summary`
and per-entry artifacts. `selection.json` binds the selected commit, source,
runner and case hashes. Raw runner summaries and receipts are not rewritten.
Missing reports, native build/source mismatch, failed setup and selected skips
all make the aggregate fail. `build.log`, `runner.log`, `ci-outcome.json`,
service/desktop readiness and screenshot metadata identify the failing phase.
Original failures remain available in each Actions run. Issue sync deduplicates
by combination/case and updates the run link; it does not close issues from a
partial passing scope.

New cases must be registered in `policy.yaml`; feature/covers stay in their
existing catalogs. Keep dependency edges in `dependencies.yaml`. Never add a
policy exclusion merely because a case failed. Local CLI and opt-in Docker
fixtures keep their existing behavior.

```sh
export PYTHONPATH=.agents/skills/qa-ui-auto/scripts
python -m unittest test_ci_selection test_ci_report test_ci_desktop test_ci_provenance test_ci_services
python -m qa_ui_auto.audit --gate
python -m qa_ui_auto.ci plan --scope selected --case-ids TC-012,TC-027
```
