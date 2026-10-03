/**
 * Taomni actions whose Linux default bindings intentionally differ from IDEA
 * "Default for XWin" (ED-PARITY-013 A4.2). Every entry names its decision; an
 * unlisted difference fails `CodeWorkspaceTab.test.tsx` ED-PARITY-013 A4.2.
 */
export const ACCEPTED_IDEA_KEYMAP_DIFFERENCES: Readonly<Record<string, string>> = {
  "workspace.navigateBack": "Alt+Left kept as a secondary (commit 2c74319a): Linux window managers grab Ctrl+Alt+Left; IDEA's Alt+Left (PreviousTab) has no Taomni action yet.",
  "workspace.navigateForward": "Alt+Right kept for the same reason as Navigate Back.",
  "workspace.refactorThis": "Ctrl+T extra is unbound in IDEA XWin, so it shadows no IDEA action.",
  "workspace.runActiveJavaFile": "Ctrl+Shift+F10 is IDEA RunClass, which Taomni splits across Run Current Target and Run Context Configuration.",
  "editor.deleteLine": "Ctrl+Shift+K extra is unbound in IDEA XWin, so it shadows no IDEA action.",
  "editor.basicCompletion": "Alt+/ is IDEA Cyclic Expand Word; ED-PARITY-020 (DEC-ALIGN-09) moves buffer-word completion there.",
};
