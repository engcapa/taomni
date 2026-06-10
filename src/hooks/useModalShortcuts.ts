import { useEffect } from "react";
import { getAppPlatform } from "../lib/runtime";

interface ModalShortcutsOptions {
  onCancel?: () => void;
  onSave?: () => void;
  onTest?: () => void;
}

export function useModalShortcuts({ onCancel, onSave, onTest }: ModalShortcutsOptions) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // 1. Esc -> Cancel
      if (e.key === "Escape") {
        if (e.defaultPrevented) return;

        if (onCancel) {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
        return;
      }

      const isMac = getAppPlatform() === "macos";
      const isSaveModifier = isMac ? e.metaKey : e.ctrlKey;
      const isTestModifier = e.altKey;

      // 2. Save modifier (Ctrl/Cmd) + S or Save modifier + Enter -> Save
      if (isSaveModifier && (e.key.toLowerCase() === "s" || e.key === "Enter")) {
        if (onSave) {
          e.preventDefault();
          e.stopPropagation();
          onSave();
        }
        return;
      }

      // 3. Test modifier (Alt/Option) + T -> Test Connection
      if (isTestModifier && e.key.toLowerCase() === "t") {
        if (onTest) {
          e.preventDefault();
          e.stopPropagation();
          onTest();
        }
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onCancel, onSave, onTest]);
}

export function getShortcutSuffixes() {
  const isMac = getAppPlatform() === "macos";
  return {
    cancel: " (Esc)",
    save: isMac ? " (⌘S)" : " (Ctrl+S)",
    test: isMac ? " (⌥T)" : " (Alt+T)",
  };
}
