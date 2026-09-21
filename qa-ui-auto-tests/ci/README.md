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
Docker SSH/MySQL containers pinned by image digest in `services.yaml`; macOS uses Homebrew OpenSSH and an isolated MySQL
data directory; Windows uses OpenSSH and an isolated MySQL ZIP installation.
Accounts, passwords, keys, ports and databases are disposable within the job VM.
The supervisor runs actual SSH login/PTY/exec, SFTP byte roundtrip and SQL DML
probes before the cases. Secrets are masked and referenced by environment name
in config artifacts. No external server, repository secret or private network
is required. Account/package mutations are limited to CI.

Java downloads are pinned by version and SHA256 in `toolchains.yaml`. JDTLS
performs real LSP initialize and checks debug/test command registration when
bundles are selected. Java Test 0.43.1 matches the ASM 9.8 family in JDTLS 1.50;
upgrading these pins requires a new joint probe. The native session seeds the
application's existing tooling-JDK setting from the prepared `JAVA_HOME`, since
a hosted image may also contain a newer, incompatible JDK. Java 25 projects
build online then offline. JDK 21 remains the default for existing provider
fixtures; jobs selecting Java 25 also install that runtime and select it only
for cases declaring `java25_projects`. Selecting both kinds must not alter
the JDK 21 completion/import candidate contract. The
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

`TC-IDE-C6-06-java-definition-realproject-native` additionally requires the
user's original external `clickhousecrud` checkout (`QA_JAVA_PROJECT_ROOT`).
That source is not part of this repository. The hosted plan records an explicit
gap on each platform and rejects explicitly selecting it; run it locally with
the original project. The in-repository Maven/Gradle definition cases still run
on hosted VMs. A generated lookalike cannot establish the external-project claim.

## Evidence and maintenance

Read the run's **qa-ui-auto-platforms-result** summary and download
`qa-summary-<invocation UUID>` and `qa-<platform>-<mode>-<invocation UUID>` artifacts.
The UUID keeps multiple reusable calls within one caller isolated. The plan
summary lists exact selected IDs, reasons and changed paths before execution. `selection.json` binds the selected commit, source,
runner and case hashes. Raw runner summaries and receipts are not rewritten.
Case failures and selected skips remain in the aggregate report but do not fail
the report workflow. Missing reports, native build/source mismatch, failed
setup, selected skips without a completed runner report, and other
infrastructure errors make the aggregate fail. `build.log`, `runner.log`, `ci-outcome.json`,
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
python -m unittest test_ci_selection test_ci_report test_ci_execute test_ci_desktop test_ci_provenance test_ci_services
python -m qa_ui_auto.audit --gate
python -m qa_ui_auto.ci plan --scope selected --case-ids TC-012,TC-027
```
