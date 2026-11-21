from pathlib import Path
from unittest import TestCase

from qa_ui_auto.module_vnc_key_observation import HELPER, HOST, find_owned
from qa_ui_auto.steps import StepError


class VncHelperOwnershipTests(TestCase):
    def setUp(self):
        self.core = Path("core/taomni.exe").resolve()
        self.host = Path("installed/vnc-client", HOST).resolve()
        self.helper = self.host.with_name(HELPER)
        self.paths = self.core, self.host, self.helper

    @staticmethod
    def process(path, pid, parent):
        return {"ExecutablePath": str(path), "ProcessId": pid, "ParentProcessId": parent}

    def test_signed_paths_follow_the_core_host_helper_lineage(self):
        core = self.process(self.core, 11, 1)
        host = self.process(self.host, 12, 11)
        helper = self.process(self.helper, 13, 12)
        self.assertEqual(find_owned([core, host, helper], *self.paths),
                         {"core": core, "host": host, "helper": helper})
        self.assertEqual(find_owned([core], *self.paths),
                         {"core": core, "host": None, "helper": None})

    def test_rejects_a_helper_from_the_core_or_an_unrelated_owner(self):
        core = self.process(self.core, 11, 1)
        host = self.process(self.host, 12, 11)
        with self.assertRaisesRegex(StepError, "legacy VNC helper"):
            find_owned([core, host, self.process(self.core.with_name(HELPER), 13, 11)], *self.paths)
        with self.assertRaisesRegex(StepError, "Unexpected process ownership"):
            find_owned([core, host, self.process(self.helper, 13, 14)], *self.paths)
