import { type WorkspaceActionMetadata } from "../types";

export const editingActionMetadata: Record<string, WorkspaceActionMetadata> = {
  "editor.deleteBackward":
  {
    id: "editor.deleteBackward",
    title: "Delete Backward",
    description: "Delete previous character or virtual column",
    category: "Edit",
    keybinding: "Backspace",
    provenance: "local",
    keywords: ["backspace", "delete", "virtual space"],
  },
  "editor.deleteForward":
  {
    id: "editor.deleteForward",
    title: "Delete Forward",
    description: "Delete next character or collapse virtual column",
    category: "Edit",
    keybinding: "Delete",
    provenance: "local",
    keywords: ["delete", "forward", "virtual space"],
  },
  "editor.insertNewline":
  {
    id: "editor.insertNewline",
    title: "Insert Newline",
    description: "Insert newline, materializing virtual space if active",
    category: "Edit",
    keybinding: "Enter",
    provenance: "local",
    keywords: ["enter", "newline", "virtual space"],
  },
  "editor.insertTab":
  {
    id: "editor.insertTab",
    title: "Insert Tab",
    description: "Insert tab or snap to next tab stop in virtual space",
    category: "Edit",
    keybinding: "Tab",
    provenance: "local",
    keywords: ["tab", "indent", "virtual space"],
  },
  "workspace.toggleCase":

  // --- Edit ---
  {
    id: "workspace.toggleCase",
    title: "Toggle Case",
    description: "Cycle uppercase, lowercase, and camelCase for selection or word under cursor",
    category: "Edit",
    keybinding: "Ctrl+Shift+U",
    provenance: "local",
    keywords: ["case", "uppercase", "lowercase", "capitalize", "toggle case"],
  },
  "workspace.joinLines":
  {
    id: "workspace.joinLines",
    title: "Join Lines",
    description: "Join lines in the selection into a single line",
    category: "Edit",
    keybinding: "Ctrl+Shift+J",
    provenance: "local",
    keywords: ["join", "merge", "lines"],
  },
  "workspace.sortLines":
  {
    id: "workspace.sortLines",
    title: "Sort Lines",
    description: "Sort selected lines alphabetically",
    category: "Edit",
    provenance: "local",
    keywords: ["sort", "alphabetical", "lines", "order"],
  },
  "workspace.reverseLines":
  {
    id: "workspace.reverseLines",
    title: "Reverse Lines",
    description: "Reverse the order of selected lines",
    category: "Edit",
    provenance: "local",
    keywords: ["reverse", "lines", "flip", "order"],
  },
  "workspace.transpose":
  {
    id: "workspace.transpose",
    title: "Transpose Lines / Characters",
    description: "Transpose characters at cursor or swap current line with next line",
    category: "Edit",
    keybinding: "Ctrl+T",
    provenance: "local",
    keywords: ["transpose", "swap", "lines", "characters"],
  },
  "workspace.unwrap":
  {
    id: "workspace.unwrap",
    title: "Unwrap / Remove Enclosing Construct",
    description: "Unwrap enclosing parentheses, braces, brackets, or quotes around cursor",
    category: "Edit",
    keybinding: "Ctrl+Shift+Delete",
    provenance: "local",
    keywords: ["unwrap", "remove", "parentheses", "braces", "quotes"],
  },
  "workspace.format":
  {
    id: "workspace.format",
    title: "Reformat Code",
    description: "Format active document or selection using effective code style and language formatter",
    category: "Edit",
    keybinding: "Ctrl+Alt+L",
    provenance: "provider",
    keywords: ["format", "reformat", "indent", "prettify", "style"],
  },
  "workspace.formatDocument":
  {
    id: "workspace.formatDocument",
    title: "Reformat Code (Alias)",
    description: "Alias for workspace.format",
    category: "Edit",
    keybinding: "Ctrl+Alt+L",
    provenance: "provider",
    keywords: ["format", "reformat", "indent", "prettify"],
  },
  "workspace.toggleFormatOnSave":
  {
    id: "workspace.toggleFormatOnSave",
    title: "Toggle Format on Save",
    description: "Automatically format file when saving",
    category: "Edit",
    provenance: "local",
    keywords: ["format", "save", "auto format"],
  },
  "workspace.optimizeImports":
  {
    id: "workspace.optimizeImports",
    title: "Optimize Imports",
    description: "Organize and clean up unused import statements",
    category: "Edit",
    keybinding: "Ctrl+Alt+O",
    provenance: "provider",
    keywords: ["import", "organize", "unused"],
  },
  "workspace.rearrangeCode":
  {
    id: "workspace.rearrangeCode",
    title: "Rearrange Code",
    description: "Rearrange code declarations and members according to arrangement rules",
    category: "Edit",
    provenance: "provider",
    keywords: ["rearrange", "members", "order", "declarations", "structure"],
  },
  "workspace.codeCleanup":
  {
    id: "workspace.codeCleanup",
    title: "Code Cleanup...",
    description: "Run batch cleanup profiles (unused imports, redundant code, style fixes) across selected scope",
    category: "Edit",
    provenance: "provider",
    keywords: ["cleanup", "inspect", "batch", "optimize", "profile"],
  },
  "workspace.parameterInfo":
  {
    id: "workspace.parameterInfo",
    title: "Parameter Info",
    description: "Show active method or function signature and parameters",
    category: "Edit",
    keybinding: "Ctrl+P",
    secondaryKeybindings: ["Ctrl+Shift+Space"],
    provenance: "provider",
    keywords: ["parameter", "signature", "arguments", "help"],
  },
  "workspace.completeCurrentStatement":
  {
    id: "workspace.completeCurrentStatement",
    title: "Complete Current Statement",
    description: "Insert missing semicolons, closing brackets, or block braces",
    category: "Edit",
    keybinding: "Ctrl+Shift+Enter",
    provenance: "partial",
    keywords: ["statement", "semicolon", "brace", "complete"],
  },
  "workspace.undoWorkspaceEdit":
  {
    id: "workspace.undoWorkspaceEdit",
    title: "Undo Workspace Edit",
    description: "Undo multi-file refactoring transaction",
    category: "Edit",
    keybinding: "Ctrl+Z",
    provenance: "local",
    keywords: ["undo", "transaction", "rollback"],
  },
  "workspace.redoWorkspaceEdit":
  {
    id: "workspace.redoWorkspaceEdit",
    title: "Redo Workspace Edit",
    description: "Redo multi-file refactoring transaction",
    category: "Edit",
    keybinding: "Ctrl+Shift+Z",
    provenance: "local",
    keywords: ["redo", "transaction"],
  }
};
