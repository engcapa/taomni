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
# Supply the independently confirmed control through the existing fixture hook
# while retaining the official case file and its normalized digest.
import qa_ui_auto.fixtures.explorer_index_probe as probe
from qa_ui_auto.runner import main

assert control["independentlyIndexed"]
probe.system_index_target = lambda: ("windowsSearch", Path(control["path"]), "Indexed by the independent equality query")
config = {"app": {"base_url":"http://127.0.0.1:5000","mode":"native","native_binary":str(binary)},
          "webdriver":{"native_driver":shutil.which("msedgedriver.exe")}, "report":{"dir":str(report),"keep_runs":0}}
cfg = report/"config.yaml"
cfg.write_text(yaml.safe_dump(config),encoding="utf-8")
base_report = report/"positive-control"
status = main(["--mode","native","--config",str(cfg),"--filter","TC-EXPLORER-016","--report-dir",str(base_report),"--require-pass"])
summary_file = next(base_report.glob("run-*/summary.json"))
summary = json.loads(summary_file.read_text(encoding="utf-8"))
receipt = json.loads(summary_file.with_name("runner_receipt.json").read_text(encoding="utf-8"))
selected = next(c for c in summary["cases"] if c["id"]=="TC-EXPLORER-016")
assert selected["case_sha256"] == entry["case_digests"]["TC-EXPLORER-016"]
assert summary["identity"] == selection["identity"] and summary["identity_stable"]
assert verify_runner_receipt(receipt)["valid"]
raise SystemExit(status)
