"""Fixtures applied per testcase. Each one is `setup(ctx)` and optional `teardown(ctx)`.

Fixtures are referenced from a testcase's `fixtures: [...]` list. Builtin set:

* reset_db        - clears Taomni persistent state for this worker before the case
* ssh_required    - probe the configured ssh.host:port over TCP; skip case otherwise
* sftp_required   - probe the configured sftp.host:port over TCP; skip case otherwise
* vnc_required    - reset the scriptable VNC fixture and expose a per-case event
                    log and command file as ${fixture.vnc_events} / ${fixture.vnc_control}
* ard_required    - macOS Screen Sharing with ARD login: ${fixture.ard_host} /
                    ${fixture.ard_port} / ${fixture.ard_user}, password in QA_ARD_PASSWORD
* jdtls_required  - JDK-on-PATH probe; skip case otherwise (never auto-fallback)
* java_test_bundle - resolve an installed java-test extension for native tests
* linux_x11_required - require the Linux X11/fcitx5 tools used by X11 gates
* workspace_root  - native-only: temp host dir seeded with files, exposed as
                    ${fixture.workspace_root}
* java_sample_projects - expose in-repo sample Maven/Gradle project roots as
                    ${fixture.maven_single_root} / ${fixture.gradle_single_root}
* java25_projects - create and compile isolated Maven + Gradle Java 25 projects
* git_diff_repo    - native-only reproducible Git history and worktree state
* editor_typing_fixtures - native-only deterministic 1 MiB / 5 MiB / small
                    Java-like plain-text fixtures for editor typing latency
* restore_24tab_fixtures - native-only deterministic 24-file workspace for
                    restore active-ready/all-ready timing measurement
* sortable_java_fixtures - native-only maven-single copy plus an unsorted
                    SortMembers.java for live source.sortMembers rearrange
* file_move_recovery_fixtures - native-only fresh folder with a simulated
                    Old.java -> New.java server-side move for recovery reversal
* java_rename_deleted_fixtures - native-only fresh folder staging the
                    deleted-after-rename (both-missing) and mixed restorable
                    journal shapes for rename-delete recovery
* view_state_fixtures - native-only 60-line Long.java for per-leaf caret,
                    scroll and fold restore across reload_window
* mail_server     - native: in-process fake IMAP/SMTP on 127.0.0.1 (seeded
                    INBOX); browser: stub server model. Exposes
                    ${fixture.mail_quick_connect}
* rdp_server_required - native-only: disposable RDP/vault credentials and a
                    free loopback port (QA_RDP_*), plus rdp-probe/Tk checks
* system_rdp_running - Windows-only: system Remote Desktop host enabled and
                    TermService running (QA_SYSTEM_RDP_PORT)
* release_build_required - native performance cases: the app under test is
                    a verified release QA build (CI capability `release`)
* rdp_baseline_required - Windows-only: TermService reference server with two
                    disposable accounts and in-session Tk targets (QA_RDP_BASELINE_*)
* rdp_audio_required - native: a default host audio output the RDP server can
                    loop back (Linux PipeWire null sink, Windows audio device;
                    macOS skips until output capture exists)

Custom fixtures live here, register in REGISTRY, and declare their name in
schema/testcase.schema.json. There is no runtime register() API.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Protocol

from . import ard_required, editor_typing_fixtures, file_move_recovery_fixtures, git_diff_repo, java25_projects, java_rename_deleted_fixtures, java_sample_projects, java_test_bundle, jdtls_required, linux_x11_required, mysql_required, reset_db, restore_24tab_fixtures, sftp_required, sortable_java_fixtures, ssh_required, view_state_fixtures, vnc_required, welcome_recents, workspace_root
from . import project_tree
from . import parity005_completion
from . import parity006_replace
from . import parity008_git
from . import parity009_ssr
from . import parity007_extract
from . import editor_save_race
from . import mail_server
from . import macos_updater
from . import rdp_server_required
from . import system_rdp_running
from . import release_build_required
from . import rdp_baseline_required
from . import rdp_audio_required
from . import xrdp_server_required
from . import backup_policy


class FixtureContext(Protocol):
    page: object
    cfg: dict
    env: dict
    worker_id: int


@dataclass
class Fixture:
    name: str
    setup: Callable[..., None]
    teardown: Callable[..., None] | None = None


REGISTRY: dict[str, Fixture] = {
    "backup_policy": Fixture("backup_policy", backup_policy.setup),
    "project_tree": Fixture("project_tree", project_tree.setup),
    "reset_db":     Fixture("reset_db",     reset_db.setup,     reset_db.teardown),
    "ssh_required": Fixture("ssh_required", ssh_required.setup),
    "sftp_required": Fixture("sftp_required", sftp_required.setup),
    "mysql_required": Fixture("mysql_required", mysql_required.setup),
    "vnc_required": Fixture("vnc_required", vnc_required.setup),
    "ard_required": Fixture("ard_required", ard_required.setup, ard_required.teardown),
    "jdtls_required": Fixture("jdtls_required", jdtls_required.setup),
    "java_test_bundle": Fixture("java_test_bundle", java_test_bundle.setup),
    "linux_x11_required": Fixture("linux_x11_required", linux_x11_required.setup),
    "workspace_root": Fixture("workspace_root", workspace_root.setup, workspace_root.teardown),
    "java_sample_projects": Fixture("java_sample_projects", java_sample_projects.setup),
    "java25_projects": Fixture("java25_projects", java25_projects.setup),
    "git_diff_repo": Fixture("git_diff_repo", git_diff_repo.setup, git_diff_repo.teardown),
    "welcome_recents": Fixture("welcome_recents", welcome_recents.setup, welcome_recents.teardown),
    "editor_typing_fixtures": Fixture("editor_typing_fixtures", editor_typing_fixtures.setup, editor_typing_fixtures.teardown),
    "restore_24tab_fixtures": Fixture("restore_24tab_fixtures", restore_24tab_fixtures.setup, restore_24tab_fixtures.teardown),
    "sortable_java_fixtures": Fixture("sortable_java_fixtures", sortable_java_fixtures.setup),
    "file_move_recovery_fixtures": Fixture("file_move_recovery_fixtures", file_move_recovery_fixtures.setup),
    "java_rename_deleted_fixtures": Fixture("java_rename_deleted_fixtures", java_rename_deleted_fixtures.setup),
    "view_state_fixtures": Fixture("view_state_fixtures", view_state_fixtures.setup),
    "editor_save_race": Fixture("editor_save_race", editor_save_race.setup, editor_save_race.teardown),
    "parity005_completion": Fixture("parity005_completion", parity005_completion.setup, parity005_completion.teardown),
    "parity006_replace": Fixture("parity006_replace", parity006_replace.setup, parity006_replace.teardown),
    "parity008_git": Fixture("parity008_git", parity008_git.setup, parity008_git.teardown),
    "parity009_ssr": Fixture("parity009_ssr", parity009_ssr.setup, parity009_ssr.teardown),
    "parity007_extract": Fixture("parity007_extract", parity007_extract.setup, parity007_extract.teardown),
    "mail_server": Fixture("mail_server", mail_server.setup, mail_server.teardown),
    "macos_updater": Fixture("macos_updater", macos_updater.setup, macos_updater.teardown),
    "rdp_server_required": Fixture("rdp_server_required", rdp_server_required.setup),
    "system_rdp_running": Fixture("system_rdp_running", system_rdp_running.setup),
    "release_build_required": Fixture("release_build_required", release_build_required.setup),
    "rdp_baseline_required": Fixture("rdp_baseline_required", rdp_baseline_required.setup, rdp_baseline_required.teardown),
    "rdp_audio_required": Fixture("rdp_audio_required", rdp_audio_required.setup, rdp_audio_required.teardown),
    "xrdp_server_required": Fixture("xrdp_server_required", xrdp_server_required.setup, xrdp_server_required.teardown),
}


class FixtureSkip(Exception):
    """Fixture decided this case is not runnable in the current environment."""


def get(name: str) -> Fixture:
    if name not in REGISTRY:
        raise KeyError(f"unknown fixture: {name}. Known: {sorted(REGISTRY)}")
    return REGISTRY[name]
