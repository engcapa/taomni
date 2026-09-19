# qa-ui-auto-tests/

End-to-end UI test artifacts for Taomni, consumed by the `qa-ui-auto` skill.

## Layout

```
qa-ui-auto-tests/
├── feature-list.md            # Feature catalog. Each section has a frontmatter block:
│                              #     <!-- feature
│                              #     id: F4.10
│                              #     status: done
│                              #     area: terminal/file-transfer
│                              #     components: [TerminalPanel, ZmodemConflictDialog]
│                              #     files:
│                              #       - src/lib/zmodem.ts
│                              #     -->
│                              # Parsed by qa_ui_auto.feature_catalog.
└── cases/
    ├── TC-XXX-<slug>.testcase.yaml  # Typed YAML testcases (hand-authored + migrated)
    └── auto/                        # gen-coverage's drafts land here
        └── TC-auto-F4.X-...yaml     # tags: [auto-generated, smoke, needs-review]
```

## How to run

Browser mode (default):

```bash
# preflight: start Vite detached so a resident server never blocks the caller
python .agents/skills/qa-ui-auto/scripts/background_job.py start --name vite \
  --log qa-ui-auto-report/_local/vite.log -- pnpm dev
python .agents/skills/qa-ui-auto/scripts/background_job.py status \
  --state qa-ui-auto-report/_local/vite.log.job.json --tail 20
export QA_SSH_PASSWORD=...

# Optional static audit; not a prerequisite to every selected execution
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.audit --gate

# real run (foreground is fine for a bounded sweep; --workers 6 on 8+ cores)
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto run --mode browser --tag smoke --workers 4
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto plan --diff HEAD
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto status --json
```

Long jobs must never be left in a foreground tool call: the agent harness waits
for the whole process tree, so a resident process freezes the session until it
exits. Start suites and native builds detached and poll them:

```bash
python .agents/skills/qa-ui-auto/scripts/background_job.py start --name browser-full \
  --log qa-ui-auto-report/_local/browser-full.log -- python -m qa_ui_auto run --mode browser --workers 6
python .agents/skills/qa-ui-auto/scripts/background_job.py wait \
  --state qa-ui-auto-report/_local/browser-full.log.job.json --timeout 3600
```

`background_job.py` works on Windows (WMI detach), Linux and macOS (`setsid`);
`wait` propagates the job's exit code and suite logs are line-buffered when
redirected.

Reports land in `qa-ui-auto-report/run-<timestamp>/`.

### Disposable SSH/MySQL services

The runner can start local Docker fixtures automatically. Set
`fixtures.start_local_sshd: true` and/or `fixtures.start_local_mysql: true` in
your uncommitted `qa-ui-auto-tests/qa-ui-auto.config.yaml`, using the example
config for ports, users, and environment-backed passwords. Services are
started once per run and removed after the run, including setup failures.
MySQL readiness includes a real `SELECT 1` through the mapped host port; a TCP
port alone is not accepted as a healthy database fixture.

## Subcommands provided by the skill

The `qa-ui-auto` skill in Claude Code wraps these tools with playbooks:

| Command | Writes to | Purpose |
|---|---|---|
| `audit` | (read-only) | Lint cases, report coverage gaps and diff impact, and enforce the baseline gate |
| `plan` | (read-only) | Select affected cases, explicit modes and native platform gaps |
| `status` | optional `--output` | Written/reviewed/current execution coverage by feature and platform |
| `fix` | feature catalog, cases, or generated catalog | Produce a focused playbook for one coverage, control, diff, or catalog gap |
| `run` | `qa-ui-auto-report/` | Execute existing browser or native testcases |
| `explore` | `qa-ui-auto-report/` | Drive a bounded exploratory browser session and write a report |

Trigger the skill in Claude Code by asking naturally: "run smoke tests", "what features have no test", "did my change break a test", "refresh feature-list from the last 5 commits", etc.

## Authoring rules

See `.agents/skills/qa-ui-auto/references/authoring.md` and `verb-catalog.md`.
The Python step library lives at `.agents/skills/qa-ui-auto/scripts/qa_ui_auto/steps/`.

## Coverage status

Use `python -m qa_ui_auto status` for written, reviewed and observed execution
coverage. Cases tagged `needs-review` or `legacy-imported` still require assertion
review. `audit --gate` checks static coverage; `status --gate --tag p0 --platform
Windows,Linux` checks current passing execution in that explicit scope.
`audit --release-evidence` additionally validates the existing release manifest.
See [.agents/skills/qa-ui-auto/references/verification.md](../.agents/skills/qa-ui-auto/references/verification.md)
for freshness, retained artifacts, performance and macOS manual evidence limits.
