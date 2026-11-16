"""Commercial native engineering workflow: persisted task app, CLI and tests."""
import os
import shlex
import sys

from .tao_real_development import CARDS, approve_files, open_workspace, test_project
from .tao_real_flow import RealFlow


def run(ctx):
    flow = RealFlow(ctx, "project", 9)
    root = (ctx.case_dir / "task-app-project").resolve()
    root.mkdir(exist_ok=True)
    python = f'& "{sys.executable}"' if os.name == "nt" else shlex.quote(sys.executable)
    command = python + " -m unittest discover -v"
    contract = " Use write_file tao-action fences, one per file, at most five. All paths stay in the bound workspace. No shell commands in this response; await explicit approval."
    with flow.evidence():
        open_workspace(flow, root)
        flow.send("Design and implement a usable Python task-tracking application from scratch using only the standard library. Create task_repository.py, task_cli.py, test_task_repository.py and README.md. TaskRepository(json_path) provides create(title), list_tasks(), complete(task_id), delete(task_id), persists every mutation, validates empty titles and reports missing IDs. The argparse CLI accepts --data FILE and create/list/complete/delete commands, returns JSON and uses a nonzero exit for invalid input. Tests use TemporaryDirectory and cover at least six scenarios: create/reload persistence, completion/reload, deletion, empty input, missing ID and a real CLI subprocess. Include design choices and short user instructions. Tests must assert behavior and clean up their data. Avoid external network and dependencies." + contract)
        flow.reply("project-design-and-implementation", 1, seconds=450)
        files = {"task_repository.py", "task_cli.py", "test_task_repository.py", "README.md"}
        flow.require(not any((root / name).exists() for name in files), "Project files were written before approval")
        approve_files(flow, root, files)
        flow.require(all((root / name).is_file() for name in files), "The actual application, CLI, tests and README were not created")
        test_project(flow, command, 2, "project-initial-tests", minimum=6)

        flow.send("For an explicit controlled failure-recovery exercise, change only task_repository.py: complete(task_id) should temporarily return the task without changing or persisting its completed state. This is intentionally wrong. Preserve all other behavior, CLI and tests so the existing completion test exposes the defect." + contract)
        flow.reply("project-controlled-regression", 3)
        approve_files(flow, root, {"task_repository.py"})
        test_project(flow, command, 4, "project-observed-failure", failed=True)

        flow.send("Diagnose the actual confirmed failing test output from the previous execution and repair task_repository.py. Preserve persisted existing tasks, public APIs, CLI and tests. Read the bound source files if useful. Propose only the necessary repair." + contract)
        flow.reply("project-failure-diagnosis-and-repair", 5)
        approve_files(flow, root, {"task_repository.py"})
        test_project(flow, command, 6, "project-repair-tests")

        flow.send("Add priority support to the existing task application. create accepts priority low/normal/high with normal default, list_tasks can filter priority, and the CLI supports --priority for create and list. Old JSON records without priority must load with normal priority. Validate invalid priorities and retain all existing behavior. Update the repository, CLI, tests and README. Add tests for persistence, filtering, invalid input, old-record compatibility and CLI priority. Keep the original test scenarios." + contract)
        flow.reply("project-feature-and-compatibility-tests", 7, seconds=450)
        approve_files(flow, root, files)
        test_project(flow, command, 8, "project-feature-tests", minimum=6)
        flow.send("Review the actual project and confirmed test results. Explain the implemented app/CLI, the observed failure and repair, priority and old-data compatibility, and remaining risks. Propose no actions and do not claim any unexecuted validation passed.")
        flow.reply("project-final-review", 9)
        flow.require(not flow.read(CARDS), "The final project review left an unexpected action pending")
        flow.record("project-delivered-files", dict(files=sorted(name for name in files if (root / name).is_file()),
                    realDisk=True, realTestProcesses=True, exactAnswerGraded=False))
        flow.screenshot("project-final")
    return "Native engineering project: " + flow.outcome
