import { useZoomTarget } from "../../../../hooks/useZoomTarget";
import { contentZoomShortcut, type ContentZoomAction } from "../../../../lib/contentZoomShortcut";
import { useCallback, useEffect } from "react";
import { CODE_WORKSPACE_DEFAULT_TREE_FONT_SIZE } from "../codeWorkspaceModel";
import { useWorkspacePreferences } from "../controller/useWorkspacePreferences";
import { DEFAULT_EDITOR_APPEARANCE_PROFILE } from "../editorAppearanceProfile";
import { findBookmarkByMnemonic } from "../todoBookmarks";
import { useWorkspaceAppearance } from "./useWorkspaceAppearance";
import { useWorkspaceTreeFocusState } from "./useWorkspaceTreeFocusState";


export interface UseWorkspaceZoomContext {
  treeFocus: ReturnType<typeof useWorkspaceTreeFocusState>;
  visible: boolean;
  preferences: ReturnType<typeof useWorkspacePreferences>;
  appearance: ReturnType<typeof useWorkspaceAppearance>;
  rootRef: import("react").RefObject<HTMLDivElement | null>;
}

export function useWorkspaceZoom(context: UseWorkspaceZoomContext) {
  const { treeFocus, visible, preferences, appearance, rootRef } = context;

  const zoomTargetForNode = useCallback((target: EventTarget | null): "tree" | "editor" => {
    const node = target instanceof Node ? target : null;
    if (node && treeFocus.treePaneRef.current?.contains(node)) return "tree";
    return "editor";
  }, []);

  const change = useCallback((action: ContentZoomAction, focus: Element | null) => {
    if (zoomTargetForNode(focus) === "tree") {
      if (action === "reset") appearance.setTreeFontSize(CODE_WORKSPACE_DEFAULT_TREE_FONT_SIZE);
      else appearance.stepTreeFontSize(action === "in" ? 1 : -1);
    } else if (action === "reset") {
      appearance.setCodeViewFontSize(DEFAULT_EDITOR_APPEARANCE_PROFILE.fontSizePx);
    } else {
      appearance.stepCodeViewFontSize(action === "in" ? 1 : -1);
    }
  }, [appearance.setCodeViewFontSize, appearance.setTreeFontSize, appearance.stepCodeViewFontSize, appearance.stepTreeFontSize, zoomTargetForNode]);
  useZoomTarget(rootRef, visible, change);

  useEffect(() => {
    if (!visible) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const action = contentZoomShortcut(event);
      if (!action || event.defaultPrevented || document.querySelector("dialog[open]")) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target && target !== document.body && !rootRef.current?.contains(target)) return;
      if (target?.closest('[data-testid="code-workspace-todos-panel"]')) return;
      if (action === "reset" && findBookmarkByMnemonic(preferences.bookmarksRef.current, "0")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      change(action, target);
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [change, preferences.bookmarksRef, rootRef, visible]);

  useEffect(() => {
    if (!visible) return;
    const el = rootRef.current;
    if (!el) return;

    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();

      const target = zoomTargetForNode(event.target);
      if (target === "tree") {
        if (event.deltaY < 0) {
          appearance.stepTreeFontSize(1);
        } else if (event.deltaY > 0) {
          appearance.stepTreeFontSize(-1);
        }
      } else if (event.deltaY < 0) {
        appearance.stepCodeViewFontSize(1);
      } else if (event.deltaY > 0) {
        appearance.stepCodeViewFontSize(-1);
      }
    };

    el.addEventListener("wheel", handleWheel, { capture: true, passive: false });
    return () => el.removeEventListener("wheel", handleWheel, { capture: true });
  }, [appearance.stepCodeViewFontSize, appearance.stepTreeFontSize, visible, zoomTargetForNode]);
  return {};
}
