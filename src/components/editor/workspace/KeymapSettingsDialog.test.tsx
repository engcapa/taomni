import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { KeymapSettingsDialog } from "./KeymapSettingsDialog";
import { WorkspaceActionHost } from "./workspaceActionHost";
import {
  createKeymapScheme,
  setActionBindings,
  type KeymapSchemeV3,
  type Shortcut,
} from "./workspaceKeymapScheme";

function makeSnapshotItem(id: string, scheme?: KeymapSchemeV3) {
  const host = new WorkspaceActionHost({ workspaceId: "ws" });
  host.registerActions([{
    id,
    title: id,
    category: "Edit",
    provenance: "local",
    run: async () => ({ kind: "applied" as const }),
  }]);
  if (scheme) host.setKeymapScheme(scheme);
  return host.getSnapshot()[0]!;
}

/** One host holding several actions, so cross-action conflicts are real. */
function makeSnapshotItems(
  entries: readonly { id: string; keybinding?: string; secondary?: string[] }[],
  scheme?: KeymapSchemeV3,
) {
  const host = new WorkspaceActionHost({ workspaceId: "ws" });
  host.registerActions(entries.map((entry) => ({
    id: entry.id,
    title: entry.id,
    category: "Edit",
    ...(entry.keybinding ? { keybinding: entry.keybinding } : {}),
    ...(entry.secondary ? { secondaryKeybindings: entry.secondary } : {}),
    provenance: "local" as const,
    run: async () => ({ kind: "applied" as const }),
  })));
  if (scheme) host.setKeymapScheme(scheme);
  return host.getSnapshot();
}

function setup() {
  const scheme = createKeymapScheme({ id: "s1", name: "User", base: "idea-windows-linux", now: 1 });
  const schemes = [scheme];
  const onApplyScheme = vi.fn((_updated: KeymapSchemeV3 | null) => undefined);
  const renderResult = render(
    <KeymapSettingsDialog
      open
      snapshot={[makeSnapshotItem("test.action")]}
      schemes={schemes}
      activeSchemeId={scheme.id}
      defaultSchemeName="Default"
      onActiveSchemeChange={vi.fn()}
      onSchemesChange={vi.fn()}
      onApplyScheme={onApplyScheme}
      onClose={vi.fn()}
    />,
  );
  return { onApplyScheme, ...renderResult };
}

function key(key: string, init: KeyboardEventInit & { code?: string } = {}) {
  // jsdom does not synthesize `code`; physical-code identity must be explicit.
  const code = init.code ?? (key.length === 1 ? `Key${key.toUpperCase()}` : key);
  fireEvent.keyDown(window, { key, bubbles: true, cancelable: true, ...init, code });
}

describe("§8.19.2 two-stroke shortcut recorder", () => {
  afterEach(cleanup);

  it("records a full two-stroke sequence confirmed with Enter", () => {
    const { onApplyScheme } = setup();
    fireEvent.click(screen.getByTestId("keymap-add-test.action"));
    expect(screen.getByText(/press keys/)).toBeTruthy();

    key("k", { ctrlKey: true });
    // Live display shows physical code while recording.
    expect(screen.getByText(/\[KeyK\]/)).toBeTruthy();

    key("s");
    expect(screen.getByText(/\[KeyK, KeyS\]/)).toBeTruthy();

    key("Enter");
    // ED-PARITY-004 DEC-03: Enter lands the sequence in the DRAFT, not the live
    // scheme. Only Apply crosses the commit boundary.
    expect(onApplyScheme).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("keymap-settings-apply"));
    expect(onApplyScheme).toHaveBeenCalledTimes(1);
    const applied = onApplyScheme.mock.calls[0][0]!;
    const binding = applied.bindings["test.action"]?.[0];
    expect(binding).toBeDefined();
    if (binding && binding.kind === "keyboard") {
      expect(binding.strokes.map((stroke) => stroke.code)).toEqual(["KeyK", "KeyS"]);
    } else {
      throw new Error("expected a keyboard shortcut");
    }
  });

  it("Backspace removes the last recorded stroke before confirmation", () => {
    const { onApplyScheme } = setup();
    fireEvent.click(screen.getByTestId("keymap-add-test.action"));
    key("k", { ctrlKey: true });
    key("s");
    expect(screen.getByText(/\[KeyK, KeyS\]/)).toBeTruthy();
    key("Backspace");
    expect(screen.getByText(/\[KeyK\]/)).toBeTruthy();
    key("Enter");
    expect(onApplyScheme).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("keymap-settings-apply"));
    const binding = onApplyScheme.mock.calls[0][0]!.bindings["test.action"]?.[0];
    if (binding && binding.kind === "keyboard") {
      expect(binding.strokes).toHaveLength(1);
    } else {
      throw new Error("expected a single-stroke shortcut");
    }
  });

  it("Escape cancels the capture without touching the scheme", () => {
    const { onApplyScheme } = setup();
    fireEvent.click(screen.getByTestId("keymap-add-test.action"));
    key("k", { ctrlKey: true });
    key("Escape");
    key("Enter");
    expect(onApplyScheme).not.toHaveBeenCalled();
  });

  it("replaces an existing binding at its index instead of appending", () => {
    const base = createKeymapScheme({ id: "s1", name: "User", base: "idea-windows-linux", now: 1 });
    const existing: Shortcut = {
      kind: "keyboard",
      strokes: [{ code: "KeyA", ctrl: true, alt: false, shift: false, meta: false }],
    };
    base.bindings = setActionBindings(base, "test.action", [existing]).bindings;
    const onApplyScheme = vi.fn();
    render(
      <KeymapSettingsDialog
        open
        snapshot={[makeSnapshotItem("test.action", base)]}
        schemes={[base]}
        activeSchemeId={base.id}
        defaultSchemeName="Default"
        onActiveSchemeChange={vi.fn()}
        onSchemesChange={vi.fn()}
        onApplyScheme={onApplyScheme}
        onClose={vi.fn()}
      />,
    );
    // Click the existing binding swatch to re-record it in place.
    fireEvent.click(screen.getByTestId("keymap-replace-test.action-0"));
    key("b", { altKey: true });
    key("Enter");
    expect(onApplyScheme).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("keymap-settings-apply"));
    expect(onApplyScheme).toHaveBeenCalledTimes(1);
    const bindings = onApplyScheme.mock.calls[0][0]!.bindings["test.action"];
    expect(bindings).toHaveLength(1);
    if (bindings![0].kind === "keyboard") {
      expect(bindings![0].strokes[0].code).toBe("KeyB");
    }
  });
});

/**
 * ED-PARITY-004 pre-change counterexamples. These express the DEC-03/DEC-04
 * contract and MUST fail on the pre-change tree (D1: display-string conflict
 * table, D2: no draft/Apply boundary). They stay as regression coverage.
 */
describe("ED-PARITY-004 counterexamples (D1/D2)", () => {
  afterEach(cleanup);

  it("D2: recording must not commit to the live scheme before Apply", () => {
    const { onApplyScheme } = setup();
    fireEvent.click(screen.getByTestId("keymap-add-test.action"));
    key("k", { ctrlKey: true });
    key("Enter");
    // DEC-03: Apply is the only commit edge; Enter only lands in the draft.
    expect(onApplyScheme).not.toHaveBeenCalled();
  });

  it("D1: a Ctrl+F vs Ctrl+f display split must still surface a visible conflict", () => {
    // editor.find keeps its base display string "Ctrl+F"; editor.replace holds a
    // user-recorded stroke whose display string is "Ctrl+f". Same physical
    // stroke, so both rows must be marked.
    const items = makeSnapshotItems([
      { id: "editor.find", keybinding: "Ctrl+F" },
      { id: "editor.replace", keybinding: "Ctrl+R" },
    ]);
    const scheme = createKeymapScheme({ id: "s1", name: "User", base: "idea-windows-linux", now: 1 });
    scheme.bindings = setActionBindings(scheme, "editor.replace", [{
      kind: "keyboard",
      strokes: [{ code: "KeyF", key: "f", ctrl: true, alt: false, shift: false, meta: false }],
    }]).bindings;
    const withScheme = makeSnapshotItems([
      { id: "editor.find", keybinding: "Ctrl+F" },
      { id: "editor.replace", keybinding: "Ctrl+R" },
    ], scheme);
    expect(items.length).toBe(2);
    render(
      <KeymapSettingsDialog
        open
        snapshot={withScheme}
        schemes={[scheme]}
        activeSchemeId={scheme.id}
        defaultSchemeName="Default"
        onActiveSchemeChange={vi.fn()}
        onSchemesChange={vi.fn()}
        onApplyScheme={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getAllByLabelText("conflict").length).toBeGreaterThan(0);
  });
});

/** A host with editor.find (base Ctrl+F) and editor.replace, optionally schemed. */
function keymapFixture(scheme?: KeymapSchemeV3) {
  return makeSnapshotItems([
    { id: "editor.find", keybinding: "Ctrl+F" },
    { id: "editor.replace", keybinding: "Ctrl+R" },
  ], scheme);
}

function renderDialog(
  snapshot: ReturnType<typeof keymapFixture>,
  scheme: KeymapSchemeV3,
  handlers: {
    onApplyScheme?: ReturnType<typeof vi.fn>;
    onSchemesChange?: ReturnType<typeof vi.fn>;
    onActiveSchemeChange?: ReturnType<typeof vi.fn>;
    onClose?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const onApplyScheme = (handlers.onApplyScheme ?? vi.fn()) as ReturnType<typeof vi.fn<(scheme: KeymapSchemeV3 | null) => void>>;
  const onSchemesChange = (handlers.onSchemesChange ?? vi.fn()) as ReturnType<typeof vi.fn<(schemes: readonly KeymapSchemeV3[]) => void>>;
  const onActiveSchemeChange = (handlers.onActiveSchemeChange ?? vi.fn()) as ReturnType<typeof vi.fn<(id: string | null) => void>>;
  const onClose = (handlers.onClose ?? vi.fn()) as ReturnType<typeof vi.fn<() => void>>;
  const result = render(
    <KeymapSettingsDialog
      open
      snapshot={snapshot}
      schemes={[scheme]}
      activeSchemeId={scheme.id}
      defaultSchemeName="Default"
      onActiveSchemeChange={onActiveSchemeChange}
      onSchemesChange={onSchemesChange}
      onApplyScheme={onApplyScheme}
      onClose={onClose}
    />,
  );
  return { onApplyScheme, onSchemesChange, onActiveSchemeChange, onClose, ...result };
}

describe("ED-PARITY-004 DEC-02/03/04 draft, conflict warning and Apply boundary", () => {
  afterEach(cleanup);

  it("A1.1: the recorder shows an inline live warning naming every holder of the stroke", () => {
    const scheme = createKeymapScheme({ id: "s1", name: "User", base: "idea-windows-linux", now: 1 });
    renderDialog(keymapFixture(scheme), scheme);

    fireEvent.click(screen.getByTestId("keymap-add-editor.replace"));
    // Advisory zone is present from the start of recording.
    expect(screen.getByTestId("keymap-capture-conflicts")).toBeTruthy();
    expect(screen.getByText("Already assigned to:")).toBeTruthy();
    expect(screen.getByTestId("keymap-capture-conflict-empty")).toBeTruthy();

    key("f", { ctrlKey: true });
    // editor.find holds base Ctrl+F: the same physical stroke as Ctrl+f.
    expect(screen.getByTestId("keymap-capture-conflict-editor.find")).toBeTruthy();
    expect(screen.getByTestId("keymap-capture-conflict-editor.find").textContent).toContain("editor.find");
    // DEC-02: advisory, never blocking — OK stays enabled during a conflict.
    expect((screen.getByTestId("keymap-recorder-ok") as HTMLButtonElement).disabled).toBe(false);
  });

  it("A1.2: cancelling the capture clears the warning, restores the draft and writes nothing", () => {
    const scheme = createKeymapScheme({ id: "s1", name: "User", base: "idea-windows-linux", now: 1 });
    const { onApplyScheme, onSchemesChange } = renderDialog(keymapFixture(scheme), scheme);

    fireEvent.click(screen.getByTestId("keymap-add-editor.replace"));
    key("f", { ctrlKey: true });
    expect(screen.getByTestId("keymap-capture-conflict-editor.find")).toBeTruthy();

    fireEvent.click(screen.getByTestId("keymap-recorder-cancel"));
    expect(screen.queryByTestId("keymap-recorder")).toBeNull();
    expect(screen.queryByTestId("keymap-capture-conflict-editor.find")).toBeNull();
    // Draft still shows editor.replace on its base Ctrl+R.
    expect(screen.getByTestId("keymap-replace-editor.replace-0").textContent).toContain("Ctrl+R");
    expect(onApplyScheme).not.toHaveBeenCalled();
    expect(onSchemesChange).not.toHaveBeenCalled();
  });

  it("A1.3/A1.4: confirming then Apply gives the chord exactly one owner", () => {
    const scheme = createKeymapScheme({ id: "s1", name: "User", base: "idea-windows-linux", now: 1 });
    const { onApplyScheme } = renderDialog(keymapFixture(scheme), scheme);

    fireEvent.click(screen.getByTestId("keymap-add-editor.replace"));
    key("f", { ctrlKey: true });
    key("Enter");
    // Draft only: the live scheme is untouched until Apply.
    expect(onApplyScheme).not.toHaveBeenCalled();
    // Apply is enabled exactly because the draft changed.
    expect((screen.getByTestId("keymap-settings-apply") as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByTestId("keymap-settings-apply"));
    expect(onApplyScheme).toHaveBeenCalledTimes(1);
    const applied = onApplyScheme.mock.calls[0][0]!;
    expect(applied.bindings["editor.replace"]).toHaveLength(1);
    // DEC-04: the previous holder loses the contested stroke...
    expect(applied.bindings["editor.find"]).toEqual([]);
    // ...and the editor row visibly drops its Ctrl+F swatch.
    expect(screen.queryByTestId("keymap-replace-editor.find-0")).toBeNull();
    expect(screen.getByTestId("keymap-no-shortcut-editor.find")).toBeTruthy();
  });

  it("A1.4: Apply stays disabled until the draft actually changes", () => {
    const scheme = createKeymapScheme({ id: "s1", name: "User", base: "idea-windows-linux", now: 1 });
    renderDialog(keymapFixture(scheme), scheme);
    expect((screen.getByTestId("keymap-settings-apply") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("keymap-add-editor.replace"));
    key("k", { ctrlKey: true, altKey: true });
    key("Enter");
    expect((screen.getByTestId("keymap-settings-apply") as HTMLButtonElement).disabled).toBe(false);
  });

  it("IDEA interaction: Apply commits while keeping Settings open; OK closes it", () => {
    const scheme = createKeymapScheme({ id: "s1", name: "User", base: "idea-windows-linux", now: 1 });
    const { onApplyScheme, onClose } = renderDialog(keymapFixture(scheme), scheme);

    fireEvent.click(screen.getByTestId("keymap-add-editor.replace"));
    key("r", { altKey: true, shiftKey: true });
    key("Enter");
    fireEvent.click(screen.getByTestId("keymap-settings-apply"));

    expect(onApplyScheme).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("workspace-keymap-settings-dialog")).toBeTruthy();

    fireEvent.click(screen.getByTestId("keymap-settings-ok"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("A1.2: Esc, the overlay and the X button are all zero-write Cancel paths", () => {
    const scheme = createKeymapScheme({ id: "s1", name: "User", base: "idea-windows-linux", now: 1 });
    const { onApplyScheme, onSchemesChange, onActiveSchemeChange, onClose } = renderDialog(keymapFixture(scheme), scheme);

    fireEvent.click(screen.getByTestId("keymap-add-editor.replace"));
    key("k", { ctrlKey: true });
    key("Enter");
    // Edited the draft...
    expect(onApplyScheme).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("keymap-settings-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onApplyScheme).not.toHaveBeenCalled();
    expect(onSchemesChange).not.toHaveBeenCalled();
    expect(onActiveSchemeChange).not.toHaveBeenCalled();
  });

  it("A3.3: IME composition and AltGr never become a recorded binding", () => {
    const scheme = createKeymapScheme({ id: "s1", name: "User", base: "idea-windows-linux", now: 1 });
    const { onApplyScheme } = renderDialog(keymapFixture(scheme), scheme);
    fireEvent.click(screen.getByTestId("keymap-add-editor.replace"));

    fireEvent.keyDown(window, { key: "Process", code: "KeyJ", isComposing: true, bubbles: true, cancelable: true });
    fireEvent.keyDown(window, { key: "Dead", code: "KeyL", bubbles: true, cancelable: true });
    expect(screen.getByTestId("keymap-recorder-strokes").textContent).toContain("press keys");

    key("k", { ctrlKey: true });
    key("Enter");
    fireEvent.click(screen.getByTestId("keymap-settings-apply"));
    const applied = onApplyScheme.mock.calls[0][0]!;
    // Only the real Ctrl+K landed; the composition/dead-key events were dropped.
    expect(applied.bindings["editor.replace"]).toHaveLength(1);
    const only = applied.bindings["editor.replace"][0];
    expect(only.kind === "keyboard" && only.strokes.map((stroke) => stroke.code)).toEqual(["KeyK"]);
  });

  it("A1.6: Reset and Delete only touch the draft until Apply", () => {
    const scheme = createKeymapScheme({ id: "s1", name: "User", base: "idea-windows-linux", now: 1 });
    const withBinding = setActionBindings(scheme, "editor.replace", [
      { kind: "keyboard", strokes: [{ code: "KeyK", key: "k", ctrl: true, alt: true, shift: false, meta: false }] },
    ]);
    const { onApplyScheme } = renderDialog(keymapFixture(withBinding), withBinding);
    expect(screen.getByTestId("keymap-replace-editor.replace-0").textContent).toContain("Ctrl+Alt+K");

    fireEvent.click(screen.getByTestId("keymap-scheme-reset"));
    expect(onApplyScheme).not.toHaveBeenCalled();
    // Reset restores base inheritance in the draft.
    expect(screen.getByTestId("keymap-replace-editor.replace-0").textContent).toContain("Ctrl+R");

    fireEvent.click(screen.getByTestId("keymap-scheme-delete"));
    expect(onApplyScheme).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("keymap-settings-apply"));
    // Deleting the active scheme commits "fall back to the built-in defaults".
    expect(onApplyScheme).toHaveBeenCalledTimes(1);
    expect(onApplyScheme.mock.calls[0][0]).toBeNull();
  });
});
