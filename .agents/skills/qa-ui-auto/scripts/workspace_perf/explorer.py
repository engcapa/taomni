"""File explorer/editor workload, shared by the two native benchmark revisions."""

from pathlib import Path
import hashlib, json, time


def dataset(root):
    root.mkdir()
    for d in range(12):
        folder = root / f"Dir{d:02}"
        folder.mkdir()
        for i in range(256):
            (folder / f"File{i:03}.txt").write_text(
                f"WORKSPACE_PERF_TREE_{d:02}_{i:03}\n" + "content\n" * 20
            )
    for i in range(24):
        head = f"WORKSPACE_PERF_TAB_{i:02}\n".encode()
        row = b"0123456789 abcdefghijklmnopqrstuvwxyz 0123456789 ABCDEFGHIJKLMNO\n"
        data = (head + row * 1100)[:65535] + b"\n"
        assert len(data) == 65536
        (root / f"Tab{i:02}.txt").write_bytes(data)
    head = b"WORKSPACE_PERF_1M\n"
    row = b"12345678 abcdefghijklmnopqrstuvwxyz abcdefghijklmnopqrstuvwxyz\n"
    data = (head + row * 18000)[:1048575] + b"\n"
    assert len(data) == 1048576
    (root / "Large1MiB.txt").write_bytes(data)
    files = sorted(p for p in root.rglob("*") if p.is_file())
    assert len(files) == 3097
    manifest = {
        p.relative_to(root).as_posix(): {
            "bytes": p.stat().st_size,
            "sha256": hashlib.sha256(p.read_bytes()).hexdigest(),
        }
        for p in files
    }
    return manifest


def run(*, binary, cfg, root, NativeHarness, NativeStepContext, VERBS, common, event):
    q = common.q
    until = common.until
    timed = common.timed
    folder = root / "explorer"
    folder.mkdir()
    project = folder / "project"
    manifest = dataset(project)
    common.retain(folder / "dataset.json", manifest)
    metrics = {"datasetFiles": len(manifest)}
    known = []

    def save():
        common.retain(folder / "metrics.json", metrics)

    click = common.click

    def file_selector(name):
        return '[data-testid="code-workspace-tree-file"][data-path=' + q(name) + "]"

    try:
        with NativeHarness(cfg, folder) as harness:
            s = harness.create_session()
            ctx = NativeStepContext(s, folder, cfg)
            try:
                VERBS["vault_first_run"](ctx, "qa-isolated-workspace-performance")
                recent = [
                    {
                        "id": "qa-workspace-perf",
                        "name": "workspace-perf",
                        "roots": [
                            {
                                "id": "perf-root",
                                "name": "workspace-perf",
                                "path": str(project),
                                "kind": "folder",
                            }
                        ],
                        "looseFiles": [],
                        "lastActiveFile": {
                            "kind": "root",
                            "rootId": "perf-root",
                            "path": "Tab00.txt",
                        },
                        "lastOpenedAt": 1793030400000,
                        "isGitRepo": False,
                    }
                ]
                s.execute(
                    "localStorage.setItem('taomni.recentWorkspaces.v1',"
                    + q(json.dumps(recent))
                    + ");return true;"
                )
                VERBS["reload_window"](ctx, None)
                s.find('[data-testid="welcome-panel"]', timeout=30)
                click(s, '[data-testid="welcome-history-tab-workspaces"]')
                row = (
                    '[data-testid="welcome-recent-workspace-row"][data-workspace-path='
                    + q(str(project))
                    + "]"
                )
                metrics["coldWorkspaceOpen"] = timed(
                    s,
                    common.click_action(row),
                    "(document.querySelector('[data-testid=\"code-workspace-editor\"]')?.textContent||'').includes('WORKSPACE_PERF_TAB_00')",
                    90,
                )
                save()
                until(
                    s,
                    "!!document.querySelector('[data-testid=\"code-workspace-tree-root\"]')",
                )
                if not s.execute(
                    'return !!document.querySelector(\'[data-testid="code-workspace-tree-file"][data-path="Tab00.txt"]\');'
                ):
                    click(s, '[data-testid="code-workspace-tree-root"]')
                until(
                    s, "!!document.querySelector(" + q(file_selector("Tab00.txt")) + ")"
                )
                # Exercise the persisted product setting so the default 12-tab limit does
                # not turn a 24-tab benchmark into an accidental eviction benchmark.
                click(s, '[data-testid="code-workspace-toolbar-more"]')
                click(s, '[data-testid="code-workspace-tab-policy-settings"]')
                s.find('[data-testid="workspace-tab-policy-limit"]', timeout=15)
                s.fill('[data-testid="workspace-tab-policy-limit"]', "32")
                click(s, '[data-testid="workspace-tab-policy-apply"]')
                s.wait_absent(
                    '[data-testid="workspace-tab-policy-settings-dialog"]', timeout=15
                )
                metrics["tabLimit"] = s.execute(
                    "return document.querySelector('[data-testid=\"code-workspace-tab\"]')?.getAttribute('data-tab-policy-limit');"
                )
                cold = []
                warm = []
                for d in range(12):
                    name = f"Dir{d:02}"
                    arrow = (
                        '[data-testid="code-workspace-tree-dir"][data-path='
                        + q(name)
                        + '] [data-testid="code-workspace-tree-dir-arrow"]'
                    )
                    child = file_selector(name + "/File255.txt")
                    cold.append(
                        timed(
                            s,
                            common.click_action(arrow),
                            "!!document.querySelector(" + q(child) + ")",
                            45,
                        )
                    )
                    click(s, arrow)
                    until(s, "!document.querySelector(" + q(child) + ")")
                    warm.append(
                        timed(
                            s,
                            common.click_action(arrow),
                            "!!document.querySelector(" + q(child) + ")",
                            45,
                        )
                    )
                    click(s, arrow)
                    until(s, "!document.querySelector(" + q(child) + ")")
                metrics["folderExpandCold"] = {"samples": cold}
                metrics["folderExpandWarm"] = {"samples": warm}
                save()
                event("cold/warm directory samples retained")
                for d in range(12):
                    name = f"Dir{d:02}"
                    arrow = (
                        '[data-testid="code-workspace-tree-dir"][data-path='
                        + q(name)
                        + '] [data-testid="code-workspace-tree-dir-arrow"]'
                    )
                    click(s, arrow)
                    until(
                        s,
                        "!!document.querySelector("
                        + q(file_selector(name + "/File255.txt"))
                        + ")",
                    )
                metrics["expandedFileRows"] = s.execute(
                    "return document.querySelectorAll('[data-testid=\"code-workspace-tree-file\"]').length;"
                )
                assert metrics["expandedFileRows"] == 3097, metrics["expandedFileRows"]
                scroll = []
                for i in range(24):
                    target = "tree.scrollHeight" if i % 2 == 0 else "0"
                    action = (
                        "const tree=document.querySelector('[data-testid=\"code-workspace-tree\"]');tree.scrollTop="
                        + target
                    )
                    predicate = (
                        "(()=>{const t=document.querySelector('[data-testid=\"code-workspace-tree\"]');return "
                        + (
                            "t.scrollTop>0 && t.scrollTop+t.clientHeight>=t.scrollHeight-2"
                            if i % 2 == 0
                            else "t.scrollTop===0"
                        )
                        + ";})()"
                    )
                    scroll.append(timed(s, action, predicate))
                metrics["treeScroll"] = {"samples": scroll}
                save()
                # Tree rows deliberately remain expanded during tab activation and typing;
                # this represents a busy explorer, rather than an empty-sidebar fast path.
                opened = []
                for i in range(1, 24):
                    name = f"Tab{i:02}.txt"
                    selector = file_selector(name)
                    action = (
                        "document.querySelector("
                        + q(selector)
                        + ").dispatchEvent(new MouseEvent('dblclick',{bubbles:true,detail:2}))"
                    )
                    opened.append(
                        timed(
                            s,
                            action,
                            "(document.querySelector('[data-testid=\"code-workspace-editor\"]')?.textContent||'').includes("
                            + q(f"WORKSPACE_PERF_TAB_{i:02}")
                            + ")",
                            45,
                        )
                    )
                metrics["fileOpen64KiB"] = {"samples": opened}
                metrics["idle24Files"] = common.resource_sample(binary)
                save()
                # The redesign intentionally uses the outer workspace tab strip. Main uses
                # its existing editor strip; both actions activate the same file owner.
                candidate = bool(
                    s.execute(
                        "return !!document.querySelector('[data-testid=\"workspace-tab\"]');"
                    )
                )
                count = s.execute(
                    "return document.querySelectorAll("
                    + q(
                        '[data-testid="workspace-tab"][data-tab-kind="file"]'
                        if candidate
                        else "[data-editor-tab-key]"
                    )
                    + ").length;"
                )
                assert count == 24, ("retained tabs", count, candidate)
                switches = []
                for i in list(range(24)) + list(reversed(range(24))):
                    name = f"Tab{i:02}.txt"
                    if candidate:
                        selector = (
                            '[data-testid="workspace-tab"][data-tab-title='
                            + q(name)
                            + "]"
                        )
                    else:
                        selector = (
                            "[data-editor-tab-key="
                            + q("root:perf-root:" + name)
                            + '] [role="tab"]'
                        )
                    switches.append(
                        timed(
                            s,
                            common.click_action(selector),
                            "(document.querySelector('[data-testid=\"code-workspace-editor\"]')?.textContent||'').includes("
                            + q(f"WORKSPACE_PERF_TAB_{i:02}")
                            + ")",
                        )
                    )
                metrics["fileTabSwitch"] = {
                    "samples": switches,
                    "entry": "outer workspace tabs" if candidate else "editor tabs",
                }
                save()
                event("24 retained files and activation samples retained")
                selector = file_selector("Large1MiB.txt")
                metrics["fileOpen1MiB"] = timed(
                    s,
                    "document.querySelector("
                    + q(selector)
                    + ").dispatchEvent(new MouseEvent('dblclick',{bubbles:true,detail:2}))",
                    "(document.querySelector('[data-testid=\"code-workspace-editor\"]')?.textContent||'').includes('WORKSPACE_PERF_1M')",
                    60,
                )
                editor = '[data-testid="code-workspace-editor"] .cm-content'
                s.click(editor)
                VERBS["native_keys"](
                    ctx,
                    {"selector": editor, "transport": "webdriver", "keys": ["Mod+End"]},
                )
                for label, keys in [
                    ("typing-warmup", "w" * 24),
                    ("typing-group1", "a" * 200),
                    ("typing-group2", "b" * 200),
                ]:
                    VERBS["native_editor_performance"](
                        ctx,
                        {
                            "selector": editor,
                            "keys": keys,
                            "capture_text": False,
                            "max_p95_ms": 150 if label != "typing-warmup" else 1000,
                            "label": label,
                        },
                    )
                VERBS["press"](ctx, "Control+s")
                expected = hashlib.sha256(
                    (project / "Large1MiB.txt").read_bytes()
                ).hexdigest()
                initial_data = (
                    b"WORKSPACE_PERF_1M\n"
                    + b"12345678 abcdefghijklmnopqrstuvwxyz abcdefghijklmnopqrstuvwxyz\n"
                    * 18000
                )[:1048575] + b"\n"
                wanted = hashlib.sha256(
                    initial_data + b"w" * 24 + b"a" * 200 + b"b" * 200
                ).hexdigest()
                deadline = time.monotonic() + 30
                while expected != wanted and time.monotonic() < deadline:
                    time.sleep(0.05)
                    expected = hashlib.sha256(
                        (project / "Large1MiB.txt").read_bytes()
                    ).hexdigest()
                assert expected == wanted, (expected, wanted)
                metrics["savedSha256"] = expected
                VERBS["native_keys"](
                    ctx,
                    {"selector": editor, "transport": "webdriver", "keys": ["Mod+z"]},
                )
                VERBS["press"](ctx, "Control+s")
                deadline = time.monotonic() + 30
                while time.monotonic() < deadline:
                    undone = hashlib.sha256(
                        (project / "Large1MiB.txt").read_bytes()
                    ).hexdigest()
                    if undone != expected:
                        break
                    time.sleep(0.05)
                assert undone != expected, "Undo must change the actual saved document"
                metrics["undoSha256"] = undone
                VERBS["native_keys"](
                    ctx,
                    {
                        "selector": editor,
                        "transport": "webdriver",
                        "keys": ["Mod+Shift+z"],
                    },
                )
                VERBS["press"](ctx, "Control+s")
                deadline = time.monotonic() + 30
                while time.monotonic() < deadline:
                    restored = hashlib.sha256(
                        (project / "Large1MiB.txt").read_bytes()
                    ).hexdigest()
                    if restored == expected:
                        break
                    time.sleep(0.05)
                assert (
                    restored == expected
                ), "Redo must restore every originally saved byte"
                metrics["redoSha256"] = restored
                metrics["idleLargeEditor"] = common.resource_sample(binary)
                s.screenshot(folder / "explorer-editor.png")
                known = common.owned_processes(binary)
                save()
                event("1 MiB typing, saved-byte and history checks retained")
            except BaseException:
                try:
                    s.screenshot(folder / "failure.png")
                except Exception:
                    pass
                raise
            finally:
                known = common.owned_processes(binary)
                s.close()
        time.sleep(1)
        table = common.process_table()
        metrics["afterExitProcesses"] = [
            p
            for p in known
            if p["pid"] in table and table[p["pid"]]["startTicks"] == p["startTicks"]
        ]
        metrics["passed"] = True
        save()
        return metrics
    except BaseException as exc:
        metrics["passed"] = False
        metrics["error"] = str(exc)
        save()
        raise

    finally:
        metrics["cleanupOwnedProcesses"] = common.cleanup_owned(known)
        save()
