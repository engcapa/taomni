# Persistent local QA fixtures

The local runner uses the same `qa_ui_auto.ci plan` and `ci_execute.py` flow as
`.github/workflows/qa-ui-auto-platforms.yml`. It does not create or delete
accounts, containers or services. Keep one disposable fixture lease running and
reuse it across browser/native batches.

Start the existing local fixtures once from the repository root:

```powershell
python qa-ui-auto-report/workspace-first/prepare-wsl-ssh.py
python qa-ui-auto-report/workspace-first/run-mysql-fixture.py
python qa-ui-auto-report/workspace-first/run-vnc-fixture.py
```

Probe the persistent lease without starting or stopping anything:

```powershell
$env:QA_SSH_PASSWORD = (Get-Content qa-ui-auto-report/workspace-first/ssh-fixture.secret -Raw).Trim()
$env:QA_VNC_PASSWORD = (Get-Content qa-ui-auto-report/workspace-first/vnc-fixture.secret -Raw).Trim()
$env:TAOMNI_TEST_MYSQL_PASSWORD = (Get-Content qa-ui-auto-report/workspace-first/mysql-fixture/password.secret -Raw).Trim()
$env:QA_CAPABILITIES = '["ssh","mysql","vnc"]'
python .agents/skills/qa-ui-auto/scripts/ci_services.py probe-reused `
  --config qa-ui-auto-report/workspace-first/browser-full-services.config.yaml
```

Those scripts keep their generated credentials under the ignored
`qa-ui-auto-report/workspace-first/` directory. `run-services.py` can be used to
load the environment references without printing credentials. The fixed local
ports are SSH/SFTP `22478`, MySQL `5526`, and VNC/control `5988/5989`.

Run a selected Windows batch with the same case IDs used by the hosted workflow:

```powershell
$env:QA_SSH_PASSWORD = Get-Content qa-ui-auto-report/workspace-first/ssh-fixture.secret
$env:QA_VNC_PASSWORD = Get-Content qa-ui-auto-report/workspace-first/vnc-fixture.secret
$env:TAOMNI_TEST_MYSQL_PASSWORD = Get-Content qa-ui-auto-report/workspace-first/mysql-fixture/password.secret
python qa-ui-auto-tests/local/run-platforms.py `
  --config qa-ui-auto-report/workspace-first/browser-full-services.config.yaml `
  --case-ids TC-WS-001,TC-WS-014,TC-WS-NATIVE-011 `
  --modes browser --reuse-server
```

For native, pass `native-full-services.config.yaml` and omit `--reuse-server`.
The runner writes per-entry `ci-outcome.json`, `environment.json`, fixture
lease/probe facts and normal `run-*/summary.json` receipts under the report
directory. Passwords must remain `${env.NAME}` references in YAML and are only
read from the current process environment.
