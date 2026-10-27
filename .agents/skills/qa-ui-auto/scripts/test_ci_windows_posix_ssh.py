"""Account isolation and partial-setup cleanup for the hosted POSIX PTY probe."""
import os
from pathlib import Path
import tempfile
import json
import re
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch
import yaml

from ci_services import Services, install
from ci_windows_posix_ssh import start
from qa_ui_auto.fixtures import FixtureSkip, get


class WindowsPosixSshTest(TestCase):
    def test_local_invocation_cannot_mutate_accounts(self):
        with patch.dict(os.environ, {"GITHUB_ACTIONS": "false"}), \
                patch("ci_services.powershell") as powershell:
            with self.assertRaisesRegex(RuntimeError, "GitHub hosted"):
                start(None, "not-an-account-password")
            powershell.assert_not_called()

    def test_unknown_runtime_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "Unknown Windows SSH runtime"):
            Services(Path("unused"), {"ssh"}, {}, ssh_windows_runtime="unknown")

    def prepare(self, directory):
        root = Path(directory) / "cygwin"
        (root / "usr/sbin").mkdir(parents=True)
        (root / "usr/sbin/sshd.exe").touch()
        (root / "etc").mkdir()
        (root / "etc/passwd").write_text("existing:*:1:1::/home/existing:/bin/bash\n")
        services = Services(Path(directory) / "report", {"ssh"}, {}, ssh_windows_runtime="cygwin")
        services.root.mkdir()
        services.private = Path(directory) / "private"
        services.private.mkdir()
        return root, services

    def commands(self, services, events):
        def run(argv):
            name = Path(str(argv[0])).name
            if name == "mkpasswd.exe":
                return f"{services.namespace}:*:1001:100:Disposable:/wrong/home:/bin/sh\n"
            if name == "cygpath.exe":
                return str(argv[-1])
            if name == "ssh-keygen.exe":
                Path(argv[-1]).touch()
            if name == "taskkill":
                events.append("process-stop")
            return ""
        return run

    def test_password_service_keeps_credentials_out_of_config_and_cleans_up_in_order(self):
        with tempfile.TemporaryDirectory() as directory:
            root, services = self.prepare(directory)
            passwd = root / "etc/passwd"
            original = passwd.read_bytes()
            events = []

            def powershell(script):
                self.assertNotIn("disposable-secret", script)
                if "Remove-LocalUser" in script:
                    events.append("account-remove")
                    return ""
                return "1234" if "-PassThru" in script else ""

            with patch.dict(os.environ, GITHUB_ACTIONS="true", QA_CYGWIN_ROOT=str(root),
                            QA_SSH_PASSWORD="separate-win32-secret"), \
                    patch("ci_services.command", side_effect=self.commands(services, events)), \
                    patch("ci_services.powershell", side_effect=powershell):
                original_path = os.environ["PATH"]
                user, port, remote = start(services, "disposable-secret")
                self.assertEqual(os.environ["QA_SSH_PASSWORD"], "separate-win32-secret")
                self.assertEqual(os.environ["QA_POSIX_SSH_PASSWORD"], "disposable-secret")
                self.assertEqual(Path(os.environ["PATH"].split(os.pathsep)[0]).resolve(), (root / "bin").resolve())
                self.assertEqual(user, services.namespace)
                self.assertGreater(port, 0)
                self.assertEqual(remote, f"/home/{user}/qa-temp")
                text = (services.private / "posix-ssh/sshd_config").read_text()
                self.assertIn("PasswordAuthentication yes", text)
                self.assertIn("PubkeyAuthentication no", text)
                self.assertIn("ListenAddress 127.0.0.1", text)
                self.assertNotIn("disposable-secret", text)
                self.assertIn(f"/home/{user}:/bin/bash", passwd.read_text())
                services.stack.close()
                self.assertEqual(os.environ["PATH"], original_path)
            self.assertEqual(passwd.read_bytes(), original)
            self.assertFalse((root / "home" / user).exists())
            self.assertEqual(events, ["process-stop", "account-remove"])

    def test_failed_account_resolution_still_removes_owned_user(self):
        with tempfile.TemporaryDirectory() as directory:
            root, services = self.prepare(directory)
            original = (root / "etc/passwd").read_bytes()
            with patch.dict(os.environ, GITHUB_ACTIONS="true", QA_CYGWIN_ROOT=str(root)), \
                    patch("ci_services.command", return_value="malformed record"), \
                    patch("ci_services.powershell") as powershell:
                with self.assertRaisesRegex(RuntimeError, "resolve"):
                    start(services, "disposable-secret")
                services.stack.close()
                self.assertIn("Remove-LocalUser", powershell.call_args.args[0])
            self.assertEqual((root / "etc/passwd").read_bytes(), original)


class PosixSshFixtureTest(TestCase):
    def test_missing_posix_endpoint_does_not_use_configured_win32_endpoint(self):
        ctx = SimpleNamespace(cfg={"ssh": {"host": "localhost", "port": 22, "user": "win32"}},
                              env={"QA_SSH_PASSWORD": "win32-password"})
        with patch("qa_ui_auto.fixtures.ssh_required.socket.create_connection") as connect:
            with self.assertRaisesRegex(FixtureSkip, "ssh_posix.host"):
                get("ssh_posix_required").setup(ctx)
            connect.assert_not_called()

    def test_missing_posix_password_does_not_use_win32_password(self):
        ctx = SimpleNamespace(cfg={"ssh_posix": {"host": "localhost", "port": 2222, "user": "posix"}},
                              env={"QA_SSH_PASSWORD": "win32-password"})
        with patch.dict(os.environ), patch("qa_ui_auto.fixtures.ssh_required.socket.create_connection") as connect:
            os.environ.pop("QA_POSIX_SSH_PASSWORD", None)
            with self.assertRaisesRegex(FixtureSkip, "QA_POSIX_SSH_PASSWORD"):
                get("ssh_posix_required").setup(ctx)
            connect.assert_not_called()

    def test_explicit_endpoint_and_password_stay_isolated(self):
        for fixture, section, password_env in (("ssh_required", "ssh", "QA_SSH_PASSWORD"),
                                               ("ssh_posix_required", "ssh_posix", "QA_POSIX_SSH_PASSWORD")):
            with self.subTest(fixture=fixture), patch.dict(os.environ):
                os.environ.pop(password_env, None)
                ctx = SimpleNamespace(cfg={section: {"host": "127.0.0.1", "port": 2229,
                                                    "user": "owned", "password": "explicit-password"}}, env={})
                with patch("qa_ui_auto.fixtures.ssh_required.socket.create_connection") as connect:
                    get(fixture).setup(ctx)
                connect.assert_called_once_with(("127.0.0.1", 2229), timeout=2.0)
                self.assertEqual(ctx.env, {password_env: "explicit-password"})

    def test_unreachable_posix_endpoint_is_explicit(self):
        ctx = SimpleNamespace(cfg={"ssh_posix": {"host": "localhost", "port": 2222, "user": "posix"}},
                              env={"QA_POSIX_SSH_PASSWORD": "posix-password"})
        with patch("qa_ui_auto.fixtures.ssh_required.socket.create_connection", side_effect=OSError("refused")):
            with self.assertRaisesRegex(FixtureSkip, "ssh_posix server.*unreachable"):
                get("ssh_posix_required").setup(ctx)


class PosixServiceOwnershipTest(TestCase):
    def test_workflow_provisions_an_isolated_posix_only_shard(self):
        root = Path(__file__).resolve().parents[4]
        workflow = yaml.safe_load((root / ".github/workflows/qa-ui-auto-entry.yml").read_text())
        step = next(step for job in workflow["jobs"].values() for step in job.get("steps", [])
                    if step.get("name") == "Prepare local service packages")
        self.assertEqual(step["env"]["QA_CAPABILITIES"], "${{ toJSON(matrix.capabilities) }}")
        self.assertIn("ci_services.py install", step["run"])
        for capabilities in ({"ssh_posix"}, {"ssh", "ssh_posix"}, {"release", "display"}):
            for operation in ("run", "build"):
                with self.subTest(capabilities=capabilities, operation=operation):
                    condition = re.sub(r"contains\(matrix.capabilities, '([^']+)'\)",
                                       lambda match: str(match[1] in capabilities), step["if"])
                    condition = condition.replace("inputs.operation", repr(operation))
                    condition = condition.replace("&&", " and ").replace("||", " or ")
                    self.assertEqual(eval(condition, {"__builtins__": {}}), operation == "run")

    def test_install_shares_cygwin_package_setup_but_keeps_normal_windows_ssh(self):
        for capabilities in ({"ssh_posix"}, {"ssh", "ssh_posix", "ssh_features"}):
            with self.subTest(capabilities=capabilities), patch.dict(os.environ, GITHUB_ACTIONS="true"), \
                    patch("ci_services.platform.system", return_value="Windows"), \
                    patch("ci_ssh_features.install") as cygwin, patch("ci_services.powershell") as win32:
                install(capabilities)
                cygwin.assert_called_once_with()
                win32.assert_called_once()

    def test_posix_only_uses_existing_host_prerequisites_on_linux_and_macos(self):
        for system in ("Linux", "Darwin"):
            with self.subTest(system=system), patch.dict(os.environ, GITHUB_ACTIONS="true"), \
                    patch("ci_services.platform.system", return_value=system), \
                    patch("ci_ssh_features.install") as cygwin, patch("ci_services.command") as command:
                install({"ssh_posix"})
                cygwin.assert_not_called()
                self.assertEqual(command.call_args.args[0],
                                 ["docker", "info", "--format", "{{.ServerVersion}}"] if system == "Linux"
                                 else ["brew", "install", "openssh"])

    def ssh(self, events):
        def ready(service):
            name = service.ssh_password_env
            events.append(("start", name, service.ssh_windows_runtime))
            service.stack.callback(events.append, ("stop", name))
            os.environ[name] = name + "-secret"
            service.config["ssh"] = {"host": "127.0.0.1", "port": 2222 if name == "QA_SSH_PASSWORD" else 2223,
                                     "user": service.namespace, "password": "${env." + name + "}"}
            return {"runtime": service.ssh_windows_runtime, "authentication": True}
        return ready

    def test_windows_parent_owns_independent_services_and_preserves_original_config(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, GITHUB_ACTIONS="true"), \
                patch("ci_services.platform.system", return_value="Windows"):
            events, config = [], {}
            with patch.object(Services, "ssh", self.ssh(events)):
                with Services(directory, {"ssh", "ssh_posix"}, config):
                    self.assertNotEqual(config["ssh"]["port"], config["ssh_posix"]["port"])
                    self.assertNotEqual(config["ssh"]["user"], config["ssh_posix"]["user"])
                    self.assertEqual(config["ssh"]["password"], "${env.QA_SSH_PASSWORD}")
                    self.assertEqual(config["ssh_posix"]["password"], "${env.QA_POSIX_SSH_PASSWORD}")
                    lease = json.loads(Path(directory, "lease.json").read_text())
                    self.assertEqual(lease["ssh"]["runtime"], "win32")
                    self.assertEqual(lease["ssh_posix"]["runtime"], "cygwin")
                    self.assertNotIn("-secret", json.dumps(lease))
            self.assertEqual(events, [("start", "QA_SSH_PASSWORD", "win32"),
                                      ("start", "QA_POSIX_SSH_PASSWORD", "cygwin"),
                                      ("stop", "QA_POSIX_SSH_PASSWORD"), ("stop", "QA_SSH_PASSWORD")])

    def test_non_windows_reuses_existing_posix_lease_and_stops_it_once(self):
        for system in ("Linux", "Darwin"):
            with self.subTest(system=system), tempfile.TemporaryDirectory() as directory, \
                    patch.dict(os.environ, GITHUB_ACTIONS="false"), \
                    patch("ci_services.platform.system", return_value=system):
                events, config = [], {}
                with patch.object(Services, "ssh", self.ssh(events)), patch("ci_services.secret", side_effect=lambda k, v: os.environ.__setitem__(k, v)):
                    if system == "Darwin":
                        os.environ["GITHUB_ACTIONS"] = "true"
                    with Services(directory, {"ssh", "ssh_posix"}, config):
                        self.assertEqual(config["ssh"]["port"], config["ssh_posix"]["port"])
                        self.assertEqual(os.environ["QA_SSH_PASSWORD"], os.environ["QA_POSIX_SSH_PASSWORD"])
                        lease = json.loads(Path(directory, "lease.json").read_text())
                        self.assertEqual(lease["ssh_posix"]["shared_with"], "ssh")
                self.assertEqual(events, [("start", "QA_SSH_PASSWORD", "win32"), ("stop", "QA_SSH_PASSWORD")])

    def test_posix_only_creates_and_cleans_a_lease_on_each_platform(self):
        for system in ("Linux", "Darwin", "Windows"):
            with self.subTest(system=system), tempfile.TemporaryDirectory() as directory, \
                    patch.dict(os.environ, GITHUB_ACTIONS="true", QA_SSH_PASSWORD="existing-win32"), \
                    patch("ci_services.platform.system", return_value=system):
                events, config = [], {}
                with patch.object(Services, "ssh", self.ssh(events)):
                    with Services(directory, {"ssh_posix"}, config):
                        self.assertEqual(set(config), {"ssh_posix"})
                        self.assertEqual(os.environ["QA_SSH_PASSWORD"], "existing-win32")
                self.assertEqual(events[-1], ("stop", "QA_POSIX_SSH_PASSWORD"))
                self.assertEqual(len(events), 2)

    def test_child_failure_cleans_both_services_without_publishing_incomplete_endpoint(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, GITHUB_ACTIONS="true"), \
                patch("ci_services.platform.system", return_value="Windows"):
            events, config = [], {}
            ready = self.ssh(events)

            def fail(service):
                facts = ready(service)
                if service.ssh_password_env == "QA_POSIX_SSH_PASSWORD":
                    raise RuntimeError("PTY readiness failed")
                return facts

            with patch.object(Services, "ssh", fail), self.assertRaisesRegex(RuntimeError, "PTY readiness"):
                with Services(directory, {"ssh", "ssh_posix"}, config):
                    self.fail("incomplete service must not be usable")
            self.assertNotIn("ssh_posix", config)
            self.assertEqual(events[-2:], [("stop", "QA_POSIX_SSH_PASSWORD"), ("stop", "QA_SSH_PASSWORD")])
            self.assertFalse(Path(directory, "lease.json").exists())
