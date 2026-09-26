import { describe, expect, it } from "vitest";
import {
  createKeymapScheme,
  displaceStroke,
  effectiveSchemeBindings,
  findStrokeConflicts,
  formatShortcut,
  isReservedStroke,
  readKeymapSchemes,
  setActionBindings,
  setActionDisabled,
  shortcutIdentity,
  shortcutsEqual,
  strokeFromKeyboardEvent,
  strokesEqual,
  writeKeymapSchemes,
  type KeymapSchemeV3,
  type Shortcut,
} from "./workspaceKeymapScheme";

function key(code: string, mods: Partial<{ ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }> = {}) {
  return strokeFromKeyboardEvent({ code, key: code.toLowerCase(), ctrlKey: !!mods.ctrl, altKey: !!mods.alt, shiftKey: !!mods.shift, metaKey: !!mods.meta });
}

function schemeWithBindings(): KeymapSchemeV3 {
  let scheme = createKeymapScheme({ id: "s1", name: "Mine", base: "idea-windows-linux" });
  scheme = setActionBindings(scheme, "editor.save", [
    { kind: "keyboard", strokes: [key("KeyS", { ctrl: true })] },
  ]);
  scheme = setActionDisabled(scheme, "editor.replace", true);
  return scheme;
}

describe("§8.18.2 KeymapSchemeV3 model", () => {
  it("records a user delta over a platform base and clears empty binding sets", () => {
    const base = createKeymapScheme({ id: "s2", name: "Base copy", base: "idea-macos" });
    expect(base.schemaVersion).toBe(3);
    expect(base.readOnly).toBe(false);

    const withBinding = setActionBindings(base, "a.b", [{ kind: "keyboard", strokes: [key("KeyK", { ctrl: true, alt: true })] }]);
    expect(withBinding.bindings["a.b"]).toHaveLength(1);
    // Removing the last binding deletes the entry entirely.
    const emptied = setActionBindings(withBinding, "a.b", []);
    expect(emptied.bindings["a.b"]).toBeUndefined();
  });

  it("matches strokes physically (code + modifiers), ignoring display key", () => {
    expect(strokesEqual(key("KeyS", { ctrl: true }), { code: "KeyS", ctrl: true, alt: false, shift: false, meta: false })).toBe(true);
    expect(strokesEqual(key("KeyS", { ctrl: true }), key("KeyS"))).toBe(false);
    expect(shortcutsEqual(
      { kind: "keyboard", strokes: [key("KeyS", { ctrl: true })] },
      { kind: "keyboard", strokes: [{ ...key("KeyS", { ctrl: true }), key: "Σ" }] },
    )).toBe(true);
    expect(shortcutsEqual(
      { kind: "mouse", button: 2, clickCount: 1, modifiers: { ctrl: false, alt: false, shift: false, meta: false } },
      { kind: "keyboard", strokes: [key("KeyS")] },
    )).toBe(false);
  });

  it("flags OS/browser-reserved bare strokes as warnings", () => {
    expect(isReservedStroke(key("F5"))).toBe(true);
    expect(isReservedStroke(key("Tab"))).toBe(true);
    expect(isReservedStroke(key("F5", { ctrl: true }))).toBe(false);
  });

  it("formats shortcuts for display", () => {
    const stroke = { ...key("KeyJ", { ctrl: true, shift: true }), key: "j" };
    expect(formatShortcut({ kind: "keyboard", strokes: [stroke] })).toBe("Ctrl+Shift+J");
  });

  it("persists schemes and round-trips through storage (per app profile)", () => {
    window.localStorage.clear();
    const scheme = schemeWithBindings();
    writeKeymapSchemes([scheme], "s1");
    const read = readKeymapSchemes();
    expect(read.recoveredFromCorrupt).toBe(false);
    expect(read.activeId).toBe("s1");
    expect(read.schemes[0].bindings["editor.save"]).toEqual([{ kind: "keyboard", strokes: [key("KeyS", { ctrl: true })] }]);
    expect(read.schemes[0].disabledActionIds).toEqual(["editor.replace"]);
    window.localStorage.clear();
  });

  it("quarantines corrupted payloads and reports the diagnostic instead of throwing", () => {
    window.localStorage.clear();
    window.localStorage.setItem("taomni.codeWorkspace.keymap.v3:index", "{not json");
    const read = readKeymapSchemes();
    expect(read.recoveredFromCorrupt).toBe(true);
    expect(window.localStorage.getItem("taomni.codeWorkspace.keymap.v3:corrupt-backup")).toBe("{not json");
    // Non-v3 schema rows are dropped individually.
    window.localStorage.setItem("taomni.codeWorkspace.keymap.v3:index", JSON.stringify([
      { schemaVersion: 3, id: "ok", name: "ok" },
      { schemaVersion: 2, id: "legacy" },
    ]));
    const partial = readKeymapSchemes();
    expect(partial.recoveredFromCorrupt).toBe(true);
    expect(partial.schemes.map((entry) => entry.id)).toEqual(["ok"]);
    window.localStorage.clear();
  });

  it("D4 counterexample: an explicit empty binding override survives persistence", () => {
    // DEC-04: displacement writes `bindings[actionId] = []` so the previous
    // holder keeps no shortcuts instead of resurrecting its base default.
    window.localStorage.clear();
    const scheme = createKeymapScheme({ id: "s3", name: "Displaced", base: "idea-windows-linux", now: 1 });
    scheme.bindings = { ...scheme.bindings, "editor.find": [] };
    writeKeymapSchemes([scheme], "s3");
    const read = readKeymapSchemes();
    expect(read.schemes[0].bindings["editor.find"]).toEqual([]);
    expect(read.recoveredFromCorrupt).toBe(false);
    window.localStorage.clear();
  });
});

describe("ED-PARITY-004 DEC-06 conflict identity and displacement", () => {
  /** Base `Ctrl+F` is held by editor.find; editor.replace defaults to `Ctrl+R`. */
  function baseMap() {
    return new Map<string, readonly Shortcut[]>([
      ["editor.find", [{ kind: "keyboard", strokes: [{ code: "KeyF", key: "F", ctrl: true, alt: false, shift: false, meta: false }] }]],
      ["editor.replace", [{ kind: "keyboard", strokes: [{ code: "KeyR", key: "R", ctrl: true, alt: false, shift: false, meta: false }] }]],
    ]);
  }

  const recordedCtrlF: Shortcut = {
    kind: "keyboard",
    // Lowercase display key — the D1 fork — but the SAME physical code.
    strokes: [{ code: "KeyF", key: "f", ctrl: true, alt: false, shift: false, meta: false }],
  };

  it("finds a conflict across the Ctrl+F / Ctrl+f display fork", () => {
    const holders = findStrokeConflicts(null, baseMap(), recordedCtrlF);
    expect(holders).toHaveLength(1);
    expect(holders[0].actionId).toBe("editor.find");
    expect(holders[0].source).toBe("base");
  });

  it("keeps Ctrl and Meta on the same letter physically distinct (A3.2)", () => {
    const ctrlX: Shortcut = { kind: "keyboard", strokes: [{ code: "KeyX", key: "x", ctrl: true, alt: false, shift: false, meta: false }] };
    const metaX: Shortcut = { kind: "keyboard", strokes: [{ code: "KeyX", key: "x", ctrl: false, alt: false, shift: false, meta: true }] };
    expect(shortcutIdentity(ctrlX)).not.toBe(shortcutIdentity(metaX));
    expect(findStrokeConflicts(null, baseMap(), ctrlX)).toHaveLength(0);
  });

  it("never reports a conflict for the action being edited", () => {
    expect(findStrokeConflicts(null, baseMap(), recordedCtrlF, { targetActionId: "editor.find" })).toHaveLength(0);
  });

  it("skips user-disabled holders, which cannot execute anyway", () => {
    const disabled = setActionDisabled(
      createKeymapScheme({ id: "d1", name: "D", base: "idea-windows-linux", now: 1 }),
      "editor.find",
      true,
    );
    expect(findStrokeConflicts(disabled, baseMap(), recordedCtrlF)).toHaveLength(0);
  });

  it("displaces the stroke from the holder and keeps its other bindings", () => {
    const map = new Map(baseMap());
    map.set("editor.find", [
      { kind: "keyboard", strokes: [{ code: "KeyF", key: "F", ctrl: true, alt: false, shift: false, meta: false }] },
      { kind: "keyboard", strokes: [{ code: "KeyF", key: "F", ctrl: false, alt: false, shift: false, meta: true }] },
    ]);
    const scheme = displaceStroke(
      createKeymapScheme({ id: "s1", name: "S", base: "idea-windows-linux", now: 1 }),
      map,
      "editor.replace",
      recordedCtrlF,
    );
    const remaining = effectiveSchemeBindings(scheme, map, "editor.find");
    expect(remaining.source).toBe("user");
    expect(remaining.shortcuts).toHaveLength(1);
    expect(remaining.shortcuts[0].kind === "keyboard" && remaining.shortcuts[0].strokes[0].meta).toBe(true);
  });

  it("writes an explicit empty override when the holder loses its last stroke", () => {
    const scheme = displaceStroke(
      createKeymapScheme({ id: "s1", name: "S", base: "idea-windows-linux", now: 1 }),
      baseMap(),
      "editor.replace",
      recordedCtrlF,
    );
    // Present-but-empty means "no shortcuts", NOT "inherit the base default".
    expect(scheme.bindings["editor.find"]).toEqual([]);
    expect(effectiveSchemeBindings(scheme, baseMap(), "editor.find").shortcuts).toHaveLength(0);
    // The new owner is untouched.
    expect(effectiveSchemeBindings(scheme, baseMap(), "editor.replace").source).toBe("base");
  });

  it("is a no-op when nothing holds the stroke", () => {
    const original = createKeymapScheme({ id: "s1", name: "S", base: "idea-windows-linux", now: 1 });
    const displaced = displaceStroke(original, baseMap(), "editor.replace", {
      kind: "keyboard",
      strokes: [{ code: "KeyJ", key: "j", ctrl: true, alt: true, shift: true, meta: false }],
    });
    expect(displaced).toBe(original);
  });
});
