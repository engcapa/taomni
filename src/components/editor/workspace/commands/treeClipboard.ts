import type { TreeSelection, WorkspaceTreeCommandPayload } from "../codeWorkspaceModel";
import type { WorkspaceCommand } from "../workspaceCommands";

export interface TreeClipboardCommandsContext {
  readonly selected: TreeSelection | null;
  stageTreeClipboard: (mode: "copy" | "cut", rootId: string, path: string, isDirectory?: boolean) => Promise<void>;
  pasteTreeClipboard: (target: { rootId: string; path: string }) => Promise<void>;
}
export function treeClipboardSource(selection: TreeSelection | null | undefined) {
  if (selection?.kind === "root") return { rootId: selection.rootId, path: "", isDirectory: true };
  if (selection?.kind === "dir") return { rootId: selection.rootId, path: selection.path, isDirectory: true };
  if (selection?.kind === "file" && selection.ref.kind === "root") return { rootId: selection.ref.rootId, path: selection.ref.path, isDirectory: false };
  return null;
}

export function createTreeClipboardCommands(context: TreeClipboardCommandsContext): WorkspaceCommand[] {
  return (["copy", "cut", "paste"] as const).map((operation) => ({
    id: `workspace.tree.${operation}`,
    title: operation === "copy" ? "Copy File" : operation === "paste" ? "Paste Files" : "Cut File (Within Workspace)",
    category: "File",
    keybinding: `Ctrl+${operation === "copy" ? "C" : operation === "cut" ? "X" : "V"}`,
    platformKeybindings: { mac: [`Meta+${operation === "copy" ? "C" : operation === "cut" ? "X" : "V"}`] },
    keywords: ["file", "clipboard", operation],
    when: (invocation) => {
      if (invocation.focus !== "tree" || invocation.modalOpen) return false;
      const payload = invocation.payload as WorkspaceTreeCommandPayload | undefined;
      const source = treeClipboardSource(payload?.selection ?? context.selected);
      return !!(payload?.directory && operation === "paste") || !!source && (operation !== "cut" || !!source.path);
    },
    run: async (invocation) => {
      const payload = invocation.payload as WorkspaceTreeCommandPayload | undefined;
      const source = treeClipboardSource(payload?.selection ?? context.selected);
      if (operation === "paste") {
        const directory = payload?.directory ?? (source ? {
          rootId: source.rootId,
          path: source.isDirectory ? source.path : source.path.slice(0, Math.max(0, source.path.lastIndexOf("/"))),
        } : null);
        if (!directory) return false;
        await context.pasteTreeClipboard(directory);
      } else {
        if (!source || operation === "cut" && !source.path) return false;
        await context.stageTreeClipboard(operation, source.rootId, source.path, source.isDirectory);
      }
    },
  }));
}
