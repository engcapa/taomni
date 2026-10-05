# Hosted QA UI automation

`.github/workflows/qa-ui-auto-platforms.yml` is independent of the existing E2E,
native and release workflows. Its failures remain visible; it does not add a PR
or release dependency. Default runners are Ubuntu 24.04 x64, Windows 2025 x64
and macOS 15 ARM64. Each can run browser and native cases. Linux native supports
the optional desktop profiles below; release builds and packaging are unchanged.

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
gh workflow run qa-ui-auto-platforms.yml --ref YOUR_BRANCH \
  -f scope=smoke -f platforms=linux -f modes=native \
  -f linux_profiles=ubuntu-24.04-xvfb,ubuntu-22.04-x11,ubuntu-22.04-vnc,ubuntu-26.04-wayland
```

GitHub only registers `workflow_dispatch` on the default branch. Publishing the
new file on a feature branch alone is insufficient. Branch validation can use a
temporary branch-specific caller; do not merge that temporary push trigger.

### Development case contract

Pull requests that touch product code receive a lightweight **Development case
contract** check before any hosted matrix is requested. It reports the changed
product paths, QA case paths and focused unit tests. A product change without a
changed executable case is an advisory warning that must be addressed or
explained in the PR/design. A mismatch between discovered case IDs and the CI
policy is an error and blocks planning.

When implementing a user-visible or native-boundary change, update or add the
case in the same change, then register its exact YAML `id` in
`qa-ui-auto-tests/ci/policy.yaml`. Add a dependency in
`qa-ui-auto-tests/ci/dependencies.yaml` only when an earlier case is required.
Keep `covers`, `feature-list.md`, controls and the testid catalog synchronized.
The check is advisory for deciding whether a case is needed; the catalog
equality check remains strict because an unregistered case makes selection
non-deterministic.

Local check from PowerShell:

```powershell
$env:PYTHONPATH = ".agents/skills/qa-ui-auto/scripts"
python .agents/skills/qa-ui-auto/scripts/qa_ui_auto/dev_contract.py `
  --base origin/main --head HEAD
python -m qa_ui_auto.audit --gate
python -m qa_ui_auto.ci plan --scope selected --case-ids TC-<id>
```

For documentation-only changes, record why no executable case is appropriate
and name the retained case or static check that protects the existing behavior.

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

### Linux native desktop profiles

`linux_profiles` is a comma-separated multi-selection in both dispatch and
reusable calls; the CLI equivalent is `--linux-profiles` (or
`QA_LINUX_PROFILES`). Omitted/empty input selects `ubuntu-24.04-xvfb`, preserving
the default runner, `linux-native` job/artifact name, smoke scope and nightly
behavior. Supplying other profiles replaces that selection: include the default
explicitly to run it as well. Duplicate names are collapsed; unknown names fail
planning. The field only expands Linux native jobs. Browser still runs once on
Ubuntu 24.04, and Windows/macOS are unaffected.

| Profile | Runner / session | Desktop | Purpose |
|---|---|---|---|
| `ubuntu-24.04-xvfb` (default) | Ubuntu 24.04 / X11 Xvfb | Openbox + xcompmgr | Existing CI baseline |
| `ubuntu-22.04-x11` | Ubuntu 22.04 / X11 Xvfb | LXQt + Openbox, no compositor | Older library/desktop compatibility; uncomposited screenshot regressions |
| `ubuntu-22.04-vnc` | Ubuntu 22.04 / X11 Xtigervnc | LXQt + Openbox, no compositor | The app runs inside a real VNC-served desktop |
| `ubuntu-26.04-wayland` | Ubuntu 26.04 LTS / native Wayland | Ubuntu GNOME Shell/Mutter, virtual 1920×1080 monitor, software rendering | Current LTS Wayland startup, WebKitGTK and app workflows |

Versioned runner labels fix the Ubuntu release family, not an immutable image:
GitHub updates runner images and apt packages. Reports retain `VERSION_ID`,
`PRETTY_NAME`, runner image version and desktop readiness. Upgrading the latest
Desktop target requires a new explicit profile, not silently changing an
existing name. These are hosted virtual desktops; physical GPU, mixed DPI,
multiple monitors and exact reproduction of a real-machine Xorg driver remain
separate acceptance targets.

Ubuntu 22.04 QA installs a checksum-pinned PipeWire 1.0.9 development/runtime
overlay because pipewire-rs needs headers newer than stock Jammy. That overlay
is part of the test environment, not evidence for stock Jammy PipeWire. The
release workflow's existing independent recipe is not changed.

The VNC desktop binds loopback, uses a disposable VNCAuth password outside
uploaded reports, and authenticates an actual RFB handshake before launch.
It does not expose a public VNC endpoint. It is independent of `vnc_required`:
that service fixture is the programmable RFB server the Taomni VNC client
connects to. The profile currently establishes hosted-desktop operation; remote
viewer reconnect/input/clipboard integration needs additional focused cases.

Wayland preparation starts GNOME/Mutter, PipeWire/WirePlumber and real GNOME
desktop portals on the job's private DBus session. It verifies compositor
protocols, a GTK `GdkWaylandDisplay` and Screenshot/ScreenCast/RemoteDesktop
portal interfaces. `GDK_BACKEND=wayland` prevents an X11 fallback. Existing
X11/XTEST/clipboard-owner and portal-consent-dependent capture/RDP cases are
listed as profile-specific capability gaps during planning. They are not
silently run with weaker assertions or counted as Wayland passes. Explicitly
selecting a case unavailable in all requested combinations fails. Portal
interface readiness alone does not prove user authorization or screen capture.
Headless Mutter initially exposes a `wl_seat` without input devices. A
job-owned Mutter RemoteDesktop session keeps a virtual keyboard and pointer
attached; readiness requires both capabilities in `desktop/wayland-info.txt`.
This enables normal WebView focus and editing on the virtual desktop and does
not establish portal consent or physical input coverage. Text paste helpers
use `wl-copy`/`wl-paste` on Wayland and retain `xclip` for X11.
CI installs the Ubuntu GNOME session, theme and portal components explicitly
with `--no-install-recommends`; provisioning runs noninteractively with a
20-minute dependency timeout. Desktop application metapackages are unnecessary
for the virtual monitor and add substantial downloads.

Selection entries, cache keys and artifact directories identify the profile.
The runner receipt binds `desktop_identity` in the native summary; aggregation
rejects a different OS release/session/profile even when the binary matches.
Inspect `desktop/desktop-readiness.json` and `desktop/desktop-failure.json`
alongside the native report. The native smoke `TC-NATIVE-CORE-001` proves app
startup and a real local PTY roundtrip; it does not claim all Wayland features.

## Runner-local dependencies

Only selected capabilities are provisioned. Linux owns uniquely named local
Docker SSH/MySQL containers pinned by image digest in `services.yaml`; macOS uses Homebrew OpenSSH and an isolated MySQL
data directory; Windows uses OpenSSH and an isolated MySQL ZIP installation.
Accounts, passwords, keys, ports and databases are disposable within the job VM.
The supervisor runs actual SSH login/PTY/exec, SFTP byte roundtrip and SQL DML
probes before the cases. Secrets are masked and referenced by environment name
in config artifacts. No external server, repository secret or private network
is required. Account/package mutations are limited to CI.

`vnc_required` selects the `vnc` capability: on every platform the job starts
the skill's scriptable RFB server (`vnc-realvnc-task/scripts/vnc_fixture_server.py`,
VNCAuth with a disposable `QA_VNC_PASSWORD`, ExtendedClipboard text+HTML) on
free loopback ports, and authenticates a real VNCAuth handshake before the
cases. Its pinned NumPy/Pillow wheels are installed only for that capability.
Each case resets the fixture and gets its own event log and command file (see
`qa_ui_auto/fixtures/vnc_required.py`); VNC jobs run cases serially. Browser
mode reaches it through the dev-server VNC bridge (`vite-plugins/vncProxy.ts`:
None/VNCAuth, Raw, DesktopSize, clipboard), which proves the panel workflow but
not the native relay, encodings, OS input or the system clipboard.

The Windows SSH fixture uses Git Bash paths (`/c/...`), while OpenSSH SFTP
reports `/C:/...`. Manual Sync verifies the translated path. The hosted Windows
OpenSSH fixture acknowledges `chmod 600` without applying POSIX bits; `TC-010`
requires an explicit unsupported-mode warning and unchanged `644` readback
there, while Linux/macOS require the actual `600` readback.

Java downloads are pinned by version and SHA256 in `toolchains.yaml`. JDTLS
performs real LSP initialize and checks debug/test command registration when
bundles are selected. Java Test 0.43.1 matches the ASM 9.8 family in JDTLS 1.50;
upgrading these pins requires a new joint probe. The native session seeds both
the application's run-owned SDK registry and its tooling-JDK setting from the
prepared `JAVA_HOME`, since a hosted image may contain an older build JDK or a
newer, incompatible JDTLS JDK. Java 25 projects
build online then offline. JDK 21 remains the default for existing provider
fixtures; jobs selecting Java 25 also install that runtime and select it only
for cases declaring `java25_projects`. Selecting both kinds must not alter
the JDK 21 completion/import candidate contract. The
whole debug/test extension server directories are retained. Product semantics
and debugging still require the actual native cases; preparation alone is not
product coverage.

Default Linux native uses Xvfb, Openbox, DBus and, when required, fcitx5/wbpy.
X11 profiles probe Python/Tk and XTEST in their session; additional Linux
profiles are described above. Windows requires a nonzero interactive
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
python -m unittest test_ci_selection test_ci_report test_ci_execute test_ci_desktop test_ci_provenance test_ci_services test_dev_contract
python -m qa_ui_auto.audit --gate
python -m qa_ui_auto.ci plan --scope selected --case-ids TC-012,TC-027
```
