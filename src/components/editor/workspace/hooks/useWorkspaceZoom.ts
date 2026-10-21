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

  useEffect(() => {
    if (!visible) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey) return;
      const targetElement = event.target instanceof Element ? event.target : null;
      if (targetElement?.closest('[data-testid="code-workspace-todos-panel"]')) return;

      const increase =
        event.key === "+" ||
        event.key === "=" ||
        event.code === "NumpadAdd";
      const decrease =
        event.key === "-" ||
        event.key === "_" ||
        event.code === "NumpadSubtract";
      const reset =
        event.key === "0" ||
        event.code === "Digit0" ||
        event.code === "Numpad0";

      if (!increase && !decrease && !reset) return;

      // Ctrl+0 is also the IDEA mnemonic-bookmark jump. A live [0] bookmark
      // owns the key; only an unclaimed stroke remains the zoom reset.
      if (reset && findBookmarkByMnemonic(preferences.bookmarksRef.current, "0")) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      const target = zoomTargetForNode(event.target);
      if (target === "tree") {
        if (increase) {
          appearance.stepTreeFontSize(1);
        } else if (decrease) {
          appearance.stepTreeFontSize(-1);
        } else {
          appearance.setTreeFontSize(CODE_WORKSPACE_DEFAULT_TREE_FONT_SIZE);
        }
      } else if (increase) {
        appearance.stepCodeViewFontSize(1);
      } else if (decrease) {
        appearance.stepCodeViewFontSize(-1);
      } else {
        appearance.setCodeViewFontSize(DEFAULT_EDITOR_APPEARANCE_PROFILE.fontSizePx);
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [appearance.setCodeViewFontSize, appearance.setTreeFontSize, appearance.stepCodeViewFontSize, appearance.stepTreeFontSize, visible, zoomTargetForNode]);

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
