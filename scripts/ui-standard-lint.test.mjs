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

test("identifies modal, command and simulated button ownership from JSX", () => {
  const cases = [
    ['<div role="dialog" aria-modal="true"/>', { L02: 1 }],
    ['<div role="menu"/>', { L13: 1 }],
    ['<div className="fixed inset-0"><canvas /></div>', {}],
    ['<div role="listbox"><div role="option" /></div>', {}],
    ['<span role="button" onClick={run} />', { L06: 1 }],
    ['<span role="button" tabIndex={0} onKeyDown={key} onClick={run} />', {}],
    ['<button type="button" className="outline-none"><svg /></button>', { L07: 1, L11: 1 }],
    ['<button type="button" aria-label={label} className="taomni-btn outline-none"><svg /></button>', {}],
    ['<button type="button">📁</button>', { L12: 1 }],
  ];
  for (const [jsx, expected] of cases) assert.deepEqual(scanUI("src/Panel.tsx", jsx), expected);
  assert.deepEqual(scanUI("src/Panel.tsx", 'import { Save as SaveIcon } from "lucide-react"; const control = <button type="button"><SaveIcon /></button>'), { L11: 1 });
});

test("requires a theme, local or owning container declaration for every unguarded theme variable", async () => {
  const { unresolvedTokens } = await import("./ui-standard-tokens.mjs");
  const scopes = {
    global: new Set(["--taomni-text"]),
    scoped: [["src/workspace/", new Set(["--taomni-tree-height"])]],
  };
  const css = ".row { --taomni-local: 3px; height: var(--taomni-tree-height); gap: var(--taomni-local); color: var(--taomni-old, var(--taomni-text)); }";
  assert.deepEqual(unresolvedTokens("src/workspace/row.css", css, scopes), []);
  assert.deepEqual(unresolvedTokens("src/shell.css", css, scopes), ["--taomni-tree-height"]);
  assert.deepEqual(unresolvedTokens("src/example.tsx", "var(--taomni-old, var(--taomni-typo))", scopes), ["--taomni-typo"]);
});

test("ratchets hand-written color and layer declarations on rendered styles", () => {
  const jsx = `<Card style={{
    color: failed ? "#c20" : "var(--taomni-text)",
    background: "linear-gradient(#12345678, #abc)",
    zIndex: -2,
    borderColor: "var(--taomni-divider, rgba(0,0,0,.2))"
  }} value="#abcdef" />`;
  assert.deepEqual(scanUI("src/Card.tsx", jsx), { "L04-inline": 2, "L05-inline": 1 });
  assert.deepEqual(scanUI("src/Card.tsx", '<Card style={{ color: userColor, zIndex: "var(--taomni-z-popover)" }} />'), {});
});
