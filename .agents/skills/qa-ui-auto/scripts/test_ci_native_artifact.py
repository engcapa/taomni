import copy
import io
import json
import platform
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import ci_native_artifact as runtime
import native_build


class NativeArtifactTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        for obj, name, value in [(runtime, 'ROOT', self.root), (native_build, 'ROOT', self.root)]:
            patcher = patch.object(obj, name, value); patcher.start(); self.addCleanup(patcher.stop)
        for name, value in [('commit','head'), ('execution_identity',{'source_sha256':'source','runner_sha256':'runner'})]:
            patcher=patch.object(runtime,name,return_value=value);patcher.start();self.addCleanup(patcher.stop)
        arch = {'x86_64':'X64','amd64':'X64','arm64':'ARM64','aarch64':'ARM64'}[platform.machine().lower()]
        self.build = dict(id='native-build-test-debug', profile='debug', arch=arch, runner='test')
        self.selection = dict(head='head', identity={'source_sha256':'source','runner_sha256':'runner'}, builds=[self.build], run_id='123')
        self.entry = dict(build_id=self.build['id'], runner='test')
        self.binary = native_build.qa_binary()
        self.binary.parent.mkdir(parents=True)
        self.binary.write_bytes(b'test binary');self.binary.chmod(0o755)
        record=dict(identifier=native_build.QA_APP_ID, binary_sha256=native_build.binary_digest(self.binary), source_sha256='source',profile='debug',build_inputs={'original':'unchanged'})
        native_build.identity_path(self.binary).write_text(json.dumps(record))
        self.sidecar=self.binary.parent/'rdp-probe';self.sidecar.write_bytes(b'sidecar');self.sidecar.chmod(0o755)
        deps=self.binary.parent/'deps';deps.mkdir();(deps/'unused').write_bytes(b'object')
        self.archive=self.root/'runtime.tar.gz'

    def test_roundtrip_preserves_original_identity_sidecar_and_executable_mode(self):
        original=native_build.identity_path(self.binary).read_bytes()
        runtime.export(self.archive,self.selection,self.build)
        self.binary.unlink();self.sidecar.unlink()
        runtime.install(self.archive,self.selection,self.entry)
        self.assertEqual(native_build.identity_path(self.binary).read_bytes(),original)
        self.assertEqual(self.sidecar.read_bytes(),b'sidecar')
        self.assertTrue(self.binary.stat().st_mode & 0o100)
        with tarfile.open(self.archive) as tar:
            self.assertFalse(any('/deps/' in m.name for m in tar.getmembers()))

    def test_wrong_invocation_is_rejected(self):
        runtime.export(self.archive,self.selection,self.build)
        wrong=copy.deepcopy(self.selection);wrong['run_id']='456'
        with self.assertRaisesRegex(ValueError,'identity differs'):
            runtime.install(self.archive,wrong,self.entry)

    def test_tampered_sidecar_is_rejected_before_publish(self):
        runtime.export(self.archive,self.selection,self.build)
        with tarfile.open(self.archive) as tar:
            contents=[(m,tar.extractfile(m).read()) for m in tar.getmembers()]
        with tarfile.open(self.archive,'w:gz') as tar:
            for m,data in contents:
                if m.name.endswith('/rdp-probe'):data=b'tampered';m.size=len(data)
                tar.addfile(m,io.BytesIO(data))
        with self.assertRaisesRegex(ValueError,'checksum'):
            runtime.install(self.archive,self.selection,self.entry)
        self.assertEqual(self.sidecar.read_bytes(),b'sidecar')

    def test_no_traversal_or_foreign_profile(self):
        for name in ('../outside','/absolute','src-tauri/target/qa-ui-auto/debug/../../escape','C:/escape','src-tauri/target/qa-ui-auto/release/taomni'):
            self.assertFalse(runtime.allowed(name,'debug'),name)
