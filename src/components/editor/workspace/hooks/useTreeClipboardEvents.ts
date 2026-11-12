import { useEffect, type RefObject } from "react";
import type { WorkspaceCommandContext } from "../workspaceCommands";

/** AppKit's predefined Edit items deliver copy/cut/paste events rather than
 * workspace keydown actions. Inputs and editor/terminal owners remain native. */
export function useTreeClipboardEvents(
  paneRef: RefObject<HTMLElement | null>,
  runner: RefObject<(commandId: string, context?: WorkspaceCommandContext) => boolean>,
) {
  useEffect(() => {
    const handle = (event: Event) => {
      if (event.defaultPrevented) return;
      const pane = paneRef.current;
      if (!pane) return;
      const element = event.target instanceof HTMLElement && event.target !== document.body
        ? event.target : document.activeElement;
      if (!(element instanceof HTMLElement) || !pane.contains(element)) return;
      if (element.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return;
      const tree = pane.querySelector('[data-testid="code-workspace-tree"]');
      if (element !== pane && !tree?.contains(element)) return;
      event.preventDefault();
      event.stopPropagation();
      runner.current(`workspace.tree.${event.type}`, { focus: "tree" });
    };
    for (const name of ["copy", "cut", "paste"]) window.addEventListener(name, handle);
    return () => {
      for (const name of ["copy", "cut", "paste"]) window.removeEventListener(name, handle);
    };
  }, [paneRef, runner]);
}
