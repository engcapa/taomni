"""Execute actual JXA scripts in a pure ObjC bridge model, never OS clipboard.

The model can independently truncate JS-array publication or NSURL aggregate
reads. It is a bridge-contract regression, not proof of real AppKit behavior;
GitHub/macOS native execution must still settle that boundary.
"""
import json
from pathlib import Path
import shutil
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from qa_ui_auto import file_clipboard_native as native

HARNESS = r"""
const vm = require('node:vm');
const input = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
const options = input.options || {};
const trace = {writes: [], clears: 0, itemReads: [], aggregateReads: [], urlCreations: []};
const nil = {isNil: () => true};
const string = (value) => ({js: String(value), isNil: () => false});
const unwrap = (value) => value && typeof value === 'object' && 'js' in value ? value.js : value;
const nativeURL = (path) => {
  path = String(path);
  const absolute = 'file://' + path.split('/').map(encodeURIComponent).join('/');
  return {isNil: () => false, isFileURL: true, path: string(path), absoluteString: string(absolute)};
};
let arrayId = 0;
class NativeArray {
  constructor(values = [], role = 'generic') { this.values = [...values]; this.role = role; this.id = ++arrayId; }
  get count() { return {valueOf: () => this.values.length}; }
  isNil() { return false; }
  addObject(value) { this.values.push(value); }
  objectAtIndex(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.values.length) throw new Error('native array index out of range');
    if (this.role === 'items') trace.itemReads.push(index);
    if (this.role === 'urls') trace.aggregateReads.push(index);
    return this.values[index];
  }
}
class Item {
  constructor() { this.formats = new Map(); }
  setStringForType(value, type) {
    if (options.rejectString) return false;
    this.formats.set(unwrap(type), unwrap(value));
    return true;
  }
  stringForType(type) {
    const value = this.formats.get(unwrap(type));
    return value == null ? nil : string(value);
  }
}
function makeItems(paths) {
  return paths.map(path => { const item = new Item(); item.setStringForType(nativeURL(path).absoluteString, string('public.file-url')); return item; });
}
let stored = makeItems(input.initialPaths || []);
function bridge(value) {
  if (Array.isArray(value)) {
    // Regression model: the old JXA $(jsArray) conversion can collapse the
    // array argument while reporting a successful write. Native addObject
    // construction never takes this implicit conversion path.
    return new NativeArray(options.collapseJsArray ? value.slice(0, 1) : value);
  }
  if (typeof value === 'string') return string(value);
  return value || {};
}
bridge.NSMutableArray = {alloc: {get init() { return new NativeArray(); }}};
bridge.NSPasteboardItem = {alloc: {get init() { return new Item(); }}};
bridge.NSURL = {
  fileURLWithPath(value) { const path = unwrap(value); trace.urlCreations.push(path); return nativeURL(path); },
  URLWithString(value) {
    try {
      const url = new URL(unwrap(value));
      if (url.protocol !== 'file:') return {...nativeURL(url.pathname), isFileURL: false};
      return nativeURL(decodeURIComponent(url.pathname));
    } catch { return nil; }
  },
};
const pb = {
  get clearContents() { stored = []; trace.clears++; return 1; },
  writeObjects(items) {
    if (!(items instanceof NativeArray)) throw new Error('writeObjects requires NSArray');
    trace.writes.push({count: Number(items.count), nativeArray: true, formats: items.values.map(item => [...item.formats])});
    if (options.rejectWrite) return false;
    stored = options.truncateNativeWrite ? items.values.slice(0, 1) : [...items.values];
    return true;
  },
  get types() { return new NativeArray(stored.length ? ['public.file-url', 'NSFilenamesPboardType'] : []); },
  get pasteboardItems() { return options.nilItems ? nil : new NativeArray(stored, 'items'); },
  readObjectsForClassesOptions(classes) {
    if (!(classes instanceof NativeArray) || classes.values[0] !== bridge.NSURL) throw new Error('NSURL class array required');
    if (options.nilAggregate) return nil;
    const values = stored.map(item => {
      const raw = item.stringForType(string('public.file-url'));
      return bridge.NSURL.URLWithString(raw);
    });
    const selected = options.aggregateFirstOnly ? values.slice(0, 1) : values;
    return new NativeArray(options.aggregateReverse ? selected.reverse() : selected, 'urls');
  },
};
bridge.NSProcessInfo = {processInfo: {environment: {objectForKey: () => string(JSON.stringify(input.paths || []))}}};
bridge.NSPasteboard = {generalPasteboard: pb};
const context = { $: bridge, ObjC: {import() {}, deepUnwrap: (value) => value instanceof NativeArray ? value.values : unwrap(value)} };
const results = [];
for (const source of input.scripts) {
  try { results.push({ok: true, value: vm.runInNewContext(source, context, {timeout: 1000})}); }
  catch (error) { results.push({ok: false, error: String(error)}); }
}
process.stdout.write(JSON.stringify({results, trace, storedPaths: stored.map(item => bridge.NSURL.URLWithString(item.stringForType(string('public.file-url'))).path.js)}));
"""


class MacFileClipboardContracts(unittest.TestCase):
    paths = ["/qa/source/中文 空格.txt", "/qa/source/second file.txt", "/qa/source/递归 目录"]

    def run_scripts(self, scripts, *, paths=None, initial=None, **options):
        node = shutil.which("node")
        self.assertIsNotNone(node, "Node is required for the pure JXA semantic harness")
        result = subprocess.run([node, "-e", HARNESS], input=json.dumps({
            "scripts": scripts, "paths": paths if paths is not None else self.paths,
            "initialPaths": initial or [], "options": options,
        }), capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_writer_constructs_every_native_item_under_injected_implicit_bridge_loss(self):
        result = self.run_scripts([native.MAC_SEED, native.MAC_READ], collapseJsArray=True)
        self.assertTrue(all(entry["ok"] for entry in result["results"]), result)
        self.assertEqual(result["storedPaths"], self.paths)
        self.assertEqual(result["trace"]["writes"][0]["count"], 3)
        self.assertEqual(result["trace"]["urlCreations"], self.paths)
        observation = json.loads(result["results"][1]["value"])
        self.assertEqual(observation["paths"], self.paths)
        self.assertEqual(observation["aggregateCount"], 3)
        self.assertEqual(observation["nativeItemCount"], 3)
        self.assertEqual(observation["itemPaths"], self.paths)
        self.assertEqual(len(observation["itemURLs"]), 3)
        self.assertEqual(result["trace"]["itemReads"], [0, 1, 2, 0, 1, 2])
        self.assertEqual(result["trace"]["aggregateReads"], [0, 1, 2, 0, 1, 2])

    def test_harness_distinguishes_the_previous_implicit_array_call_under_injected_loss(self):
        previous = native.host._JXA_PRELUDE + """
var items = JSON.parse(arg).map(function(path) {
  var item = $.NSPasteboardItem.alloc.init;
  item.setStringForType($.NSURL.fileURLWithPath($(path)).absoluteString, $('public.file-url'));
  return item;
});
pb.clearContents;
pb.writeObjects($(items));
"""
        result = self.run_scripts([previous], collapseJsArray=True)
        self.assertTrue(result["results"][0]["ok"])
        self.assertEqual(result["storedPaths"], self.paths[:1])
        self.assertEqual(result["trace"]["writes"][0]["count"], 1)

    def test_true_write_result_cannot_hide_native_item_truncation(self):
        result = self.run_scripts([native.MAC_SEED], truncateNativeWrite=True)
        self.assertFalse(result["results"][0]["ok"])
        detail = result["results"][0]["error"]
        self.assertIn('"wrote":true', detail)
        self.assertIn('"nativeItemCount":1', detail)
        self.assertIn('"aggregateCount":1', detail)
        self.assertIn('"expectedPaths":', detail)

    def test_per_item_success_does_not_mask_aggregate_nsurl_reader_collapsing(self):
        result = self.run_scripts([native.MAC_SEED, native.MAC_READ], aggregateFirstOnly=True)
        self.assertFalse(result["results"][0]["ok"])
        observation = json.loads(result["results"][1]["value"])
        self.assertEqual(observation["paths"], self.paths[:1])
        self.assertEqual(observation["aggregatePaths"], self.paths[:1])
        self.assertEqual(observation["aggregateCount"], 1)
        self.assertEqual(observation["nativeItemCount"], 3)
        self.assertEqual(observation["itemPaths"], self.paths)
        self.assertEqual(len(observation["itemURLs"]), 3)

    def test_order_and_exact_filename_bytes_are_preserved_and_readback_guard_is_strict(self):
        paths = ["/qa/ leading ", "/qa/#%\nline.txt", "/qa/目录/é.txt"]
        result = self.run_scripts([native.MAC_SEED, native.MAC_READ], paths=paths)
        self.assertTrue(all(entry["ok"] for entry in result["results"]), result)
        self.assertEqual(json.loads(result["results"][1]["value"])["paths"], paths)
        reversed_result = self.run_scripts([native.MAC_SEED], aggregateReverse=True)
        self.assertFalse(reversed_result["results"][0]["ok"])

    def test_nil_aggregate_or_item_enumeration_cannot_pass_a_nonempty_seed(self):
        for options in [{"nilAggregate": True}, {"nilItems": True}, {"rejectWrite": True}, {"rejectString": True}]:
            with self.subTest(options=options):
                result = self.run_scripts([native.MAC_SEED], **options)
                self.assertFalse(result["results"][0]["ok"])

    def test_read_observes_all_preexisting_items_without_any_write(self):
        result = self.run_scripts([native.MAC_READ], initial=self.paths)
        self.assertTrue(result["results"][0]["ok"])
        observation = json.loads(result["results"][0]["value"])
        self.assertEqual(observation["aggregatePaths"], self.paths)
        self.assertEqual(observation["itemPaths"], self.paths)
        self.assertEqual(result["trace"]["writes"], [])
        self.assertEqual(result["trace"]["clears"], 0)

    def test_python_adapter_uses_real_scripts_and_does_not_replace_aggregate_paths(self):
        observed = self.run_scripts([native.MAC_READ], initial=self.paths, aggregateFirstOnly=True)
        payload = observed["results"][0]["value"]
        with patch.object(native.platform, "system", return_value="Darwin"), \
                patch.object(native.host, "_jxa", return_value=payload) as jxa:
            result = native.read()
            jxa.assert_called_once_with(native.MAC_READ)
        self.assertEqual(result["paths"], self.paths[:1])
        self.assertEqual(result["itemPaths"], self.paths)
        with patch.object(native.platform, "system", return_value="Darwin"), \
                patch.object(native.host, "_jxa") as jxa:
            native.seed(SimpleNamespace(), self.paths)
            jxa.assert_called_once_with(native.MAC_SEED, json.dumps(self.paths))


if __name__ == "__main__":
    unittest.main()
