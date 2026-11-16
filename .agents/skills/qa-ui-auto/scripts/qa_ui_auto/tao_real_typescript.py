"""Commercial TypeScript engineering through the real approved native actions."""
import os
import shlex
import shutil

from .tao_real_development import CARDS, approve_files, open_workspace, test_project
from .tao_real_flow import RealFlow


def run(ctx):
    flow = RealFlow(ctx, "project-typescript", 9)
    root = (ctx.case_dir / "typescript-task-project").resolve()
    root.mkdir(exist_ok=True)
    node = shutil.which("node")
    flow.require(bool(node), "TypeScript engineering requires the configured Node 22 runtime")
    executable = f'& "{node}"' if os.name == "nt" else shlex.quote(node)
    command = executable + " --experimental-strip-types --test task_repository.test.ts"
    contract = " Use write_file tao-action fences, one per file, at most five. All paths stay in the bound workspace. No shell commands in this reply; wait for explicit approval."
    files = {"task_repository.ts", "task_cli.ts", "task_repository.test.ts", "README.md"}
    with flow.evidence():
        open_workspace(flow, root)
        flow.send("Design and implement a usable TypeScript task-tracking application from scratch with only Node.js 22 standard modules. Use ESM imports with explicit .ts extensions and erasable TypeScript types; no build step, npm packages or network. Create task_repository.ts, task_cli.ts, task_repository.test.ts and README.md. Export TaskRepository(jsonPath) with synchronous create(title), listTasks(), complete(taskId), delete(taskId); persist every mutation as JSON. Reject empty titles and missing IDs. The CLI accepts --data FILE and create/list/complete/delete, returns JSON and nonzero exit on invalid input. Use node:test and node:assert/strict with isolated temporary directories and cleanup. At least six real tests: create/reload, complete/reload, delete, empty input, missing ID and actual CLI subprocess. Explain design and how to run using node --experimental-strip-types. subprocess CLI execution must use process.execPath and --experimental-strip-types." + contract)
        flow.reply("typescript-design-and-implementation", 1, seconds=450)
        flow.require(not any((root / name).exists() for name in files), "Files were written before approval")
        approve_files(flow, root, files)
        flow.require(all((root / name).is_file() for name in files), "The typed application, CLI, tests and README are incomplete")
        test_project(flow, command, 2, "typescript-initial-tests", minimum=6)

        flow.send("For an explicit controlled failure-recovery exercise, change only task_repository.ts: complete(taskId) must temporarily return the task without changing or persisting its completed state. This is intentionally wrong. Preserve all other behavior and tests so the current completion test exposes the defect." + contract)
        flow.reply("typescript-controlled-regression", 3)
        approve_files(flow, root, {"task_repository.ts"})
        test_project(flow, command, 4, "typescript-observed-failure", failed=True, minimum=6)

        flow.send("Diagnose the actual confirmed failing native test output and repair task_repository.ts. Keep public APIs, persisted existing data, CLI and tests. Propose only the necessary implementation repair." + contract)
        flow.reply("typescript-diagnose-and-repair", 5)
        approve_files(flow, root, {"task_repository.ts"})
        test_project(flow, command, 6, "typescript-repair-tests", minimum=6)

        flow.send("Extend the existing typed task application with priority low/normal/high, default normal. create accepts priority, listTasks can filter priority, CLI create/list support --priority. Old JSON data without priority must load as normal. Reject invalid priorities. Preserve current API compatibility and all existing tests. Update repository, CLI, README and tests for persistence, filtering, invalid input, legacy JSON and CLI priority." + contract)
        flow.reply("typescript-feature-extension", 7, seconds=450)
        approve_files(flow, root, files)
        test_project(flow, command, 8, "typescript-feature-tests", minimum=10)
        flow.send("Review the actual project and confirmed test results. Explain implementation, the observed failure and repair, priority and old-data compatibility, and remaining risks. Do not propose actions or claim unexecuted validation.")
        flow.reply("typescript-final-review", 9)
        flow.require(not flow.read(CARDS), "Final review unexpectedly proposes more actions")
        flow.record("typescript-delivered-files", dict(files=sorted(name for name in files if (root / name).is_file()), realDisk=True, realTestProcesses=True))
        flow.screenshot("typescript-project-final")
    return "Native TypeScript engineering project: " + flow.outcome
