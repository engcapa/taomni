import { afterEach, describe, expect, it, vi } from "vitest";
import { setKeymapPlatformOverride } from "../workspaceKeymapPlatform";
import { WorkspaceActionHost } from "../workspaceActionHost";
import { createTreeClipboardCommands } from "./treeClipboard";
import type { TreeSelection } from "../codeWorkspaceModel";

afterEach(() => setKeymapPlatformOverride(null));

describe("tree clipboard actions", () => {
  it("uses explicit context targets and exposes Ctrl/Cmd bindings without editor ownership", async () => {
    const context = {
      selected: { kind: "file", ref: { kind: "root", rootId: "one", path: "src/binary.bin" } } as TreeSelection,
      stageTreeClipboard: vi.fn(async () => {}), pasteTreeClipboard: vi.fn(async () => {}),
    };
    const commands = createTreeClipboardCommands(context);
    expect(commands[0].keybinding).toBe("Ctrl+C");
    expect(commands[0].platformKeybindings).toEqual({ mac: ["Meta+C"] });
    expect(commands[2].when?.({ focus: "editor" })).toBe(false);
    expect(commands[2].when?.({ focus: "tree" })).toBe(true);
    await commands[0].run({ focus: "tree" });
    expect(context.stageTreeClipboard).toHaveBeenCalledWith("copy", "one", "src/binary.bin", false);
    await commands[2].run({ focus: "tree", payload: { directory: { rootId: "two", path: "dest" } } });
    expect(context.pasteTreeClipboard).toHaveBeenCalledWith({ rootId: "two", path: "dest" });
    await commands[2].run({ focus: "tree" });
    expect(context.pasteTreeClipboard).toHaveBeenLastCalledWith({ rootId: "one", path: "src" });
  });

  it("copies root references, pastes to root and does not cut roots/loose files", async () => {
    const context = { selected: { kind: "root", rootId: "two" } as TreeSelection, stageTreeClipboard: vi.fn(async () => {}), pasteTreeClipboard: vi.fn(async () => {}) };
    const [copy, cut, paste] = createTreeClipboardCommands(context);
    expect(cut.when?.({ focus: "tree" })).toBe(false);
    await copy.run({ focus: "tree" });
    expect(context.stageTreeClipboard).toHaveBeenCalledWith("copy", "two", "", true);
    await paste.run({ focus: "tree" });
    expect(context.pasteTreeClipboard).toHaveBeenCalledWith({ rootId: "two", path: "" });
    context.selected = { kind: "file", ref: { kind: "loose", id: "loose", path: "/outside" } };
    expect(copy.when?.({ focus: "tree" })).toBe(false);
    expect(paste.when?.({ focus: "tree" })).toBe(false);
  });

  it.each(["linux", "windows", "mac"] as const)("dispatches the correct %s chord once with editor/IME ownership protected", async (platform) => {
    setKeymapPlatformOverride(platform);
    let focus: "tree" | "editor" = "tree";
    const context = { selected: { kind: "dir", rootId: "two", path: "dest" } as TreeSelection, stageTreeClipboard: vi.fn(async () => {}), pasteTreeClipboard: vi.fn(async () => {}) };
    const editorCopy = vi.fn(async () => {});
    const host = new WorkspaceActionHost({ workspaceId: "tree-test", getContext: () => ({ focus }) });
    host.registerCommands([...createTreeClipboardCommands(context), {
      id: "workspace.editor.copy", title: "Copy", category: "Edit", keybinding: "Ctrl+C", keybindings: ["Meta+C"],
      when: (input) => input.focus === "editor", run: editorCopy,
    }]);
    const event = (meta: boolean) => ({ key: "c", code: "KeyC", ctrlKey: !meta, metaKey: meta, altKey: false, shiftKey: false, preventDefault: vi.fn(), stopPropagation: vi.fn() });
    const key = event(platform === "mac");
    const dispatched = await host.dispatchKeydown(key);
    expect(dispatched?.id).toBe("workspace.tree.copy");
    expect(context.stageTreeClipboard).toHaveBeenCalledTimes(1);
    expect(editorCopy).not.toHaveBeenCalled();
    const composing = host.dispatchKeydownV2({ event: event(platform === "mac"), workspaceId: "tree-test", targetViewId: null, composing: true });
    expect(composing.kind).toBe("rejected");
    focus = "editor";
    await host.dispatchKeydown(event(platform === "mac"));
    expect(editorCopy).toHaveBeenCalledTimes(1);
    expect(context.stageTreeClipboard).toHaveBeenCalledTimes(1);
    host.dispose();
  });

  it("registers with the real action host and keeps Copy/Paste disabled outside the tree", async () => {
    const context = { selected: { kind: "dir", rootId: "two", path: "dest" } as TreeSelection, stageTreeClipboard: vi.fn(async () => {}), pasteTreeClipboard: vi.fn(async () => {}) };
    const host = new WorkspaceActionHost({ workspaceId: "tree-test" });
    host.registerCommands(createTreeClipboardCommands(context));
    expect(host.getState("workspace.tree.copy", { focus: "tree" }).availability).toBe("available");
    expect(host.getState("workspace.tree.copy", { focus: "editor" }).availability).toBe("disabled");
    await host.execute("workspace.tree.paste", { focus: "tree" });
    expect(context.pasteTreeClipboard).toHaveBeenCalledExactlyOnceWith({ rootId: "two", path: "dest" });
    host.dispose();
  });
});
