import { useCallback } from "react";
import type { WorkspaceFocus } from "../workspaceActionRegistry";


export interface UseWorkspaceCommandFocusContext {
  treePaneRef: import("react").RefObject<HTMLElement | null>;
  editorPaneRef: import("react").RefObject<HTMLElement | null>;
}

export function useWorkspaceCommandFocus(context: UseWorkspaceCommandFocusContext) {
  const { treePaneRef, editorPaneRef } = context;

  const commandFocusForTarget = useCallback((target: EventTarget | null): WorkspaceFocus => {
    const node = target instanceof Node ? target : null;
    if (!node) return "workspace";
    // Terminal dock marks itself with data-workspace-focus="terminal".
    const el = node instanceof Element ? node : node.parentElement;
    if (el?.closest?.('[data-workspace-focus="terminal"]')) return "terminal";
    if (el?.closest?.('[data-workspace-focus="modal"]') || el?.closest?.('[role="dialog"]') || el?.closest?.('[data-testid$="-popup"]')) return "modal";
    if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && !el.closest(".cm-editor")) return "modal";
    if (treePaneRef.current?.contains(node)) return "tree";
    if (editorPaneRef.current?.contains(node)) return "editor";
    return "workspace";
  }, []);

  const isSurfaceOwnedKeyEvent = useCallback((target: EventTarget | null): boolean => {
    const node = target instanceof Node ? target : null;
    const element = node instanceof Element ? node : node?.parentElement;
    return Boolean(element?.closest?.(
      '[data-testid="code-workspace-editor-search"], [data-testid="markdown-preview-search"], [data-testid="code-workspace-breadcrumbs"], [data-testid="code-workspace-highlighting-widget"], [data-testid="code-workspace-todos-panel"], [data-taomni-context-menu], [data-testid="code-workspace-search-everywhere"]'
      // ED-PARITY-004 S7/A3.5: the Keymap settings + Cheat Sheet surfaces own
      // their own keyboard state. Their filter/search inputs must receive
      // Ctrl+F as text instead of the workspace dispatcher opening the editor
      // find panel behind the dialog. The Keymap recorder keeps working
      // because it listens on window capture independently of this guard.
      + ', [data-testid="workspace-keymap-settings-dialog"], [data-testid="keymap-cheatsheet-dialog"], [data-testid="code-workspace-undo-confirm"]'
      // ED-PARITY-009: the Structural Search dialog owns Esc/Ctrl+Enter and text input.
      + ', [data-testid="structural-search-dialog"]'
      // ED-PARITY-017: the in-place naming session owns Esc/Enter/Shift+F6/Alt+Shift+O.
      + ', [data-testid="code-workspace-inline-rename"]'
      // Debugger popups/dialogs own their fields, Esc and Delete.
      + ', [data-testid="debug-breakpoint-popup"], [data-testid="debug-breakpoints-dialog"], [data-testid="debug-evaluate-dialog"]',
    ));
  }, []);

  const isNativeTextInputTarget = useCallback((target: EventTarget | null): boolean => {
    const node = target instanceof Node ? target : null;
    const element = node instanceof Element ? node : node?.parentElement;
    return Boolean(
      (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
      && !element.closest(".cm-editor"),
    );
  }, []);

  const isEditorSurfaceKeyEvent = useCallback((target: EventTarget | null): boolean => {
    const node = target instanceof Node ? target : null;
    const element = node instanceof Element ? node : node?.parentElement;
    return Boolean(element?.closest?.(".cm-editor"));
  }, []);
  return { commandFocusForTarget, isSurfaceOwnedKeyEvent, isNativeTextInputTarget, isEditorSurfaceKeyEvent };
}
