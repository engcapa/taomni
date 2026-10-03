/**
 * ED-PARITY-017 DEC-017-01: where refactoring options are specified. IDEA's
 * `Editor › Code Editing › Refactorings` offers "In the editor" (default,
 * in-place naming) and "In modal dialogs". Read on every invocation so a
 * change applies to the next refactoring without a reload.
 */

export type RefactorOptionsMode = "editor" | "dialog";

export const REFACTOR_OPTIONS_STORAGE_KEY = "taomni.codeWorkspace.refactorOptions.v1";

export function readRefactorOptionsMode(): RefactorOptionsMode {
  try {
    const raw = window.localStorage.getItem(REFACTOR_OPTIONS_STORAGE_KEY);
    if (!raw) return "editor";
    const parsed = JSON.parse(raw) as { mode?: unknown };
    return parsed?.mode === "dialog" ? "dialog" : "editor";
  } catch {
    return "editor";
  }
}

export function writeRefactorOptionsMode(mode: RefactorOptionsMode): void {
  try {
    window.localStorage.setItem(REFACTOR_OPTIONS_STORAGE_KEY, JSON.stringify({ mode }));
  } catch {
    // Storage can be unavailable (private window); the choice then lasts
    // only for the current invocation.
  }
}
