import { describe, expect, it, vi } from "vitest";
import { WorkspaceActionHost } from "./workspaceActionHost";
import {
  createKeymapScheme,
  setActionBindings,
  setActionDisabled,
  type KeymapSchemeV3,
} from "./workspaceKeymapScheme";
import type { WorkspaceActionDefinition } from "./workspaceActionRegistry";
import { createCodeMirrorActionKeymap } from "./workspaceCodeMirrorKeymap";

function keyEvent(code: string, mods: Partial<{ ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }> = {}) {
  return {
    key: code.replace("Key", "").toLowerCase(),
    code,
    ctrlKey: !!mods.ctrl,
    altKey: !!mods.alt,
    shiftKey: !!mods.shift,
    metaKey: !!mods.meta,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
}

function makeHost(actions: WorkspaceActionDefinition[]): WorkspaceActionHost {
  const host = new WorkspaceActionHost({ workspaceId: "ws-km" });
  host.registerActions(actions);
  return host;
}

function userScheme(mutate: (scheme: KeymapSchemeV3) => KeymapSchemeV3): KeymapSchemeV3 {
  return mutate(createKeymapScheme({ id: "u1", name: "User", base: "idea-windows-linux" }));
}

describe("§8.18.2 scheme-aware binding resolution", () => {
  const saveAction: WorkspaceActionDefinition = {
    id: "editor.save",
    title: "Save File",
    category: "File",
    keybinding: "Ctrl+s",
    provenance: "local",
    run: async () => ({ kind: "applied" }),
  };
  const findAction: WorkspaceActionDefinition = {
    id: "workspace.find",
    title: "Find",
    category: "Search",
    keybinding: "Ctrl+f",
    provenance: "local",
    run: async () => ({ kind: "applied" }),
  };

  it("resolves built-in defaults without a scheme and executes through the frozen evaluation", async () => {
    const host = makeHost([saveAction]);
    const resolved = host.prepareBinding(keyEvent("KeyS", { ctrl: true }));
    expect(resolved.resolution).toBe("single");
    expect(resolved.candidates[0].source).toBe("base");
    expect(resolved.candidates[0].evaluation.actionId).toBe("editor.save");

    const dispatched = await host.dispatchKeydown(keyEvent("KeyS", { ctrl: true }));
    expect(dispatched?.id).toBe("editor.save");
    expect(dispatched?.result.kind).toBe("applied");
  });

  it("lets a user scheme override defaults and reports source=user", async () => {
    const host = makeHost([saveAction]);
    host.setKeymapScheme(userScheme((scheme) => setActionBindings(scheme, "editor.save", [
      { kind: "keyboard", strokes: [{ code: "KeyD", key: "d", ctrl: true, alt: true, shift: false, meta: false }] },
    ])));

    // Old default no longer matches.
    expect(host.prepareBinding(keyEvent("KeyS", { ctrl: true })).resolution).toBe("none");
    // New binding resolves with user provenance.
    const resolved = host.prepareBinding(keyEvent("KeyD", { ctrl: true, alt: true }));
    expect(resolved.resolution).toBe("single");
    expect(resolved.candidates[0].source).toBe("user");

    // Snapshot shows the effective binding so all surfaces share one truth.
    const snapshotItem = host.getSnapshot().find((item) => item.id === "editor.save");
    expect(snapshotItem?.keybinding).toBe("Ctrl+Alt+d");
  });

  it("keeps user-disabled actions visible in search but unavailable to dispatch", async () => {
    const host = makeHost([findAction]);
    host.setKeymapScheme(userScheme((scheme) => setActionDisabled(scheme, "workspace.find", true)));

    const state = host.getState("workspace.find");
    expect(state.availability).toBe("disabled");
    expect(state.disabledReason).toBe("userDisabled");

    // Search keeps the action listed (with its disabled state).
    const found = host.search("find");
    expect(found).toHaveLength(1);

    // Dispatch refuses instead of executing.
    const result = await host.dispatchKeydown(keyEvent("KeyF", { ctrl: true }));
    expect(result).toBeNull();
  });

  it("never executes when two available actions share one stroke — conflict surfaces", async () => {
    const duplicate: WorkspaceActionDefinition = {
      ...findAction,
      id: "workspace.find2",
      title: "Find Too",
      keybinding: "Ctrl+f",
    };
    const host = makeHost([findAction, duplicate]);
    const resolved = host.prepareBinding(keyEvent("KeyF", { ctrl: true }));
    expect(resolved.resolution).toBe("conflict");

    const dispatched = await host.dispatchKeydown(keyEvent("KeyF", { ctrl: true }));
    expect(dispatched).toBeNull();
  });

  it("D3 counterexample: an explicit empty override must not resurrect the base binding", () => {
    const duplicate: WorkspaceActionDefinition = {
      ...findAction,
      id: "workspace.find2",
      title: "Find Too",
      keybinding: "Ctrl+f",
    };
    const host = makeHost([findAction, duplicate]);
    // DEC-04 displacement: the new holder is granted Ctrl+f and the previous
    // holder is written an EXPLICIT empty override, not an absent entry.
    const displaced = userScheme((scheme) => {
      const granted = setActionBindings(scheme, "workspace.find2", [
        { kind: "keyboard", strokes: [{ code: "KeyF", key: "f", ctrl: true, alt: false, shift: false, meta: false }] },
      ]);
      return { ...granted, bindings: { ...granted.bindings, "workspace.find": [] } };
    });
    host.setKeymapScheme(displaced);

    const resolved = host.prepareBinding(keyEvent("KeyF", { ctrl: true }));
    expect(resolved.resolution).toBe("single");
    expect(resolved.candidates).toHaveLength(1);
    expect(resolved.candidates[0].actionId).toBe("workspace.find2");
  });

  it("DEC-05: all three dispatch entries report an observable conflict rejection", async () => {
    const duplicate: WorkspaceActionDefinition = {
      ...findAction,
      id: "workspace.find2",
      title: "Find Too",
      keybinding: "Ctrl+f",
    };
    const notices: {
      entry: string;
      actionIds: string[];
      consumed: boolean;
      keybinding: string;
    }[] = [];
    const host = new WorkspaceActionHost({
      workspaceId: "ws-conflict-signal",
      onBindingConflict: (notice) => notices.push(notice),
    });
    host.registerActions([findAction, duplicate]);

    // Entry 1: the async window dispatcher — must not execute or swallow.
    const first = keyEvent("KeyF", { ctrl: true });
    expect(await host.dispatchKeydown(first)).toBeNull();
    expect(first.preventDefault).not.toHaveBeenCalled();

    // Entry 2: the typed gated dispatcher.
    const second = host.dispatchKeydownV2({
      event: keyEvent("KeyF", { ctrl: true }),
      workspaceId: "ws-conflict-signal",
      targetViewId: null,
    });
    expect(second).toEqual({ kind: "rejected", reason: "conflict" });

    // Entry 3: the editor adapter — still consumes (so CodeMirror cannot
    // reinterpret the dead chord) but now emits the same signal.
    const third = keyEvent("KeyF", { ctrl: true });
    const handled = createCodeMirrorActionKeymap(host, {
      actionIds: ["workspace.find", "workspace.find2"],
      editorContextProvider: () => ({ focus: "editor", hasActiveFile: true }),
    }).keydown(third as unknown as KeyboardEvent, null as never);
    expect(handled).toBe(true);
    expect(third.preventDefault).toHaveBeenCalled();

    // D3 root cause: before this card the third entry swallowed the key with
    // no signal at all, and the first two disagreed about consumption.
    expect(notices.map((notice) => notice.entry)).toEqual(["dispatch", "dispatch-v2", "editor-keymap"]);
    expect(notices.map((notice) => notice.consumed)).toEqual([false, false, true]);
    for (const notice of notices) {
      expect(notice.actionIds).toEqual(["workspace.find", "workspace.find2"]);
      expect(notice.keybinding).toBe("Ctrl+f");
    }
  });

  it("D1: diagnostics group Ctrl+F and Ctrl+f as one contested stroke", () => {
    // workspace.find keeps its BASE default (display renders as "Ctrl+F");
    // workspace.find2 holds a user-recorded stroke (display "Ctrl+f"). The
    // physical code is identical, so the two are ONE contested stroke.
    const duplicate: WorkspaceActionDefinition = {
      ...findAction,
      id: "workspace.find2",
      title: "Find Too",
      keybinding: "Ctrl+z",
    };
    const scheme = userScheme((s) => setActionBindings(s, "workspace.find2", [
      { kind: "keyboard", strokes: [{ code: "KeyF", key: "f", ctrl: true, alt: false, shift: false, meta: false }] },
    ]));
    const host = makeHost([findAction, duplicate]);
    host.setKeymapScheme(scheme);

    const conflicts = host.getBindingDiagnostics();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].actionIds.sort()).toEqual(["workspace.find", "workspace.find2"]);

    // Both rows carry the diagnostic, so the settings surface can mark them.
    const snapshot = host.getSnapshot();
    for (const id of ["workspace.find", "workspace.find2"]) {
      expect(snapshot.find((item) => item.id === id)?.bindingConflicts).toHaveLength(1);
    }
    // The display strings really do differ — this is the exact D1 fork.
    expect(snapshot.find((item) => item.id === "workspace.find")?.keybinding).toBe("Ctrl+F");
    expect(snapshot.find((item) => item.id === "workspace.find2")?.keybinding).toBe("Ctrl+f");
  });

  it("recognizes two-stroke chords: first stroke waits, second executes, Esc cancels", async () => {
    const chordAction: WorkspaceActionDefinition = {
      id: "editor.reformat",
      title: "Reformat",
      category: "Edit",
      keybinding: "Ctrl+Alt+Shift+k",
      secondaryKeybindings: ["Ctrl+Alt+Shift+j"],
      provenance: "local",
      run: async () => ({ kind: "applied" }),
    };
    // Register as a real two-stroke shortcut via user scheme.
    const host = makeHost([chordAction]);
    host.setKeymapScheme(userScheme((scheme) => setActionBindings(scheme, "editor.reformat", [
      {
        kind: "keyboard",
        strokes: [
          { code: "KeyK", key: "k", ctrl: true, alt: true, shift: true, meta: false },
          { code: "KeyJ", key: "j", ctrl: false, alt: false, shift: false, meta: false },
        ],
      },
    ])));

    const first = host.prepareBinding(keyEvent("KeyK", { ctrl: true, alt: true, shift: true }));
    expect(first.resolution).toBe("shadowed");
    expect(first.reason).toBe("chord-pending");
    expect(host.hasPendingChord()).toBe(true);

    // Second stroke completes the chord.
    const done = await host.dispatchKeydown(keyEvent("KeyJ"));
    expect(done?.id).toBe("editor.reformat");
    expect(host.hasPendingChord()).toBe(false);

    // Chord wait cancels on Escape-with-no-binding.
    host.prepareBinding(keyEvent("KeyK", { ctrl: true, alt: true, shift: true }));
    expect(host.hasPendingChord()).toBe(true);
    await host.dispatchKeydown(keyEvent("Escape"));
    expect(host.hasPendingChord()).toBe(false);
  });
});
