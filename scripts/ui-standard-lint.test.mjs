import assert from "node:assert/strict";
import test from "node:test";
import { increases, scanUI } from "./ui-standard-lint.mjs";

test("reports application calls and literal controls in core and module renderers", () => {
  const fixture = 'const form = <button className="z-[950] text-[12px] bg-red-500" onClick={() => window.confirm(msg)}>移除</button>';
  for (const path of ["src/Modal.tsx", "src-tauri/plugins/mail/renderer/Mail.tsx"]) {
    assert.deepEqual(scanUI(path, fixture), { L10: 1, L04: 1, L05: 1, L09: 1, L01: 1, L08: 1 });
  }
});

test("keeps command comments and a token-based selection popup clean", () => {
  assert.deepEqual(scanUI("Select.tsx", '// window.confirm(msg)\nconst control = <button type="button" role="combobox" className="taomni-btn">{label}</button>'), {});
  assert.deepEqual(scanUI("ui.css", "/* z-index: 100 */ .menu { z-index: var(--taomni-z-popover) }"), {});
});

test("a reduction in another file or rule cannot mask a new violation", () => {
  const before = { "a.tsx": { L01: 2 }, "b.tsx": { L09: 3 } };
  assert.deepEqual(increases({ "b.tsx": { L01: 1, L09: 1 } }, before), ["b.tsx L01: 0 -> 1"]);
});
