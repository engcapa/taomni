import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
import yaml
from ci_native_artifact import install
from native_build import identity_path, qa_binary
from qa_ui_auto.runner_receipt import verify_runner_receipt

root = Path.cwd()
report = root / "probe-results"
selection = json.loads((root / "probe-input/selection/selection.json").read_text(encoding="utf-8"))
entry = next(e for e in selection["entries"] if e["id"] == "windows-native-shard-1")
install(root / "probe-input/runtime/runtime.tar.gz", selection, entry)
binary = qa_binary(release=True)
shutil.copy2(identity_path(binary), report / "build-identity.json")
control = json.loads((report / "control.json").read_text(encoding="utf-8-sig"))
case = next((root/"qa-ui-auto-tests/cases").glob("TC-EXPLORER-016-*"))
cases = root/"probe-input/cases"
cases.mkdir(exist_ok=True)
case_data = yaml.safe_load(case.read_text(encoding="utf-8"))
# A second positive control forces a known unique hit outside both fallback roots.
# Preserve all DOM actions and assertions from the candidate case; pin the path to
# the exact shortcut the independent OLE DB query has already returned.
for step in case_data["steps"]:
    if "fill" in step and step["fill"]["value"] == "${fixture.index_probe_query}":
        step["fill"]["value"] = control["name"]
    if "wait_for" in step:
        step["wait_for"] = step["wait_for"].replace('${fixture.index_probe_source}', '[data-provider="windowsSearch"]').replace('${fixture.index_probe_result}', '[data-path="' + control['path'].replace('\\','\\\\') + '"]')
(cases/case.name).write_text(yaml.safe_dump(case_data,allow_unicode=True,sort_keys=False), encoding="utf-8")
config = {"app":{"base_url":"http://127.0.0.1:5000","mode":"native","native_binary":str(binary)},
          "webdriver":{"native_driver":shutil.which("msedgedriver.exe")}, "report":{"dir":str(report),"keep_runs":0}}
cfg = report/"config.yaml"
cfg.write_text(yaml.safe_dump(config),encoding="utf-8")
(base_report := report/"positive-control").mkdir(exist_ok=True)
subprocess.run([sys.executable,"-m","qa_ui_auto","run","--mode","native","--config",str(cfg),"--cases",str(cases),"--filter","TC-EXPLORER-016","--report-dir",str(base_report),"--require-pass"],check=True)
receipt = json.loads(next(base_report.glob("run-*/runner_receipt.json")).read_text())
assert verify_runner_receipt(receipt)["valid"]
