import { describe, expect, it, vi } from "vitest";
import {
  dispatchWorkspaceCommandKeydown,
  runWorkspaceCommand,
  workspaceCommandMatchesKeybinding,
  type WorkspaceCommand,
} from "./workspaceCommands";

function command(overrides: Partial<WorkspaceCommand> = {}): WorkspaceCommand {
  return {
    id: "workspace.findInFiles",
    title: "Find in Files",
    category: "Search",
    keybinding: "Ctrl+Shift+F",
    run: vi.fn(),
    ...overrides,
  };
}

describe("workspaceCommands", () => {
  it("matches exact modifier combinations and named arrow keys", () => {
    expect(workspaceCommandMatchesKeybinding(command(), {
      key: "f",
      ctrlKey: true,
      shiftKey: true,
      altKey: false,
      metaKey: false,
    })).toBe(true);
    expect(workspaceCommandMatchesKeybinding(command(), {
      key: "f",
      ctrlKey: true,
      shiftKey: true,
      altKey: true,
      metaKey: false,
    })).toBe(false);
    expect(workspaceCommandMatchesKeybinding(command({ keybinding: "Ctrl+Alt+Left" }), {
      key: "ArrowLeft",
      ctrlKey: true,
      shiftKey: false,
      altKey: true,
      metaKey: false,
    })).toBe(true);
  });

  it("dispatches the first enabled matching command and consumes the event", () => {
    const disabled = command({ id: "disabled", when: () => false });
    const enabled = command({ id: "enabled" });
    const event = {
      key: "F",
      ctrlKey: true,
      shiftKey: true,
      altKey: false,
      metaKey: false,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    expect(dispatchWorkspaceCommandKeydown([disabled, enabled], { focus: "editor" }, event)?.id).toBe("enabled");
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(enabled.run).toHaveBeenCalledWith({ focus: "editor" });
  });

  it("runs commands by id only when their context predicate allows it", () => {
    const run = vi.fn();
    const editorOnly = command({ id: "editor-only", when: (context) => context.focus === "editor", run });

    expect(runWorkspaceCommand([editorOnly], "editor-only", { focus: "tree" })).toBe(false);
    expect(runWorkspaceCommand([editorOnly], "editor-only", { focus: "editor" })).toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });
});
