import { type WorkspaceActionMetadata } from "../types";

export const refactoringActionMetadata: Record<string, WorkspaceActionMetadata> = {
  "workspace.refactorThis":

  // --- Refactor ---
  {
    id: "workspace.refactorThis",
    title: "Refactor This…",
    description: "Open context popup with all applicable refactoring actions",
    category: "Refactor",
    keybinding: "Ctrl+Alt+Shift+T",
    provenance: "provider",
    keywords: ["refactor", "extract", "inline", "rename", "change signature"],
  },
  "workspace.renameSymbol":
  {
    id: "workspace.renameSymbol",
    title: "Rename Symbol",
    description: "Rename symbol across references with conflict verification",
    category: "Refactor",
    keybinding: "Shift+F6",
    provenance: "provider",
    keywords: ["rename", "symbol", "refactor"],
  },
  "workspace.rename":
  {
    id: "workspace.rename",
    title: "Rename Symbol (Alias)",
    description: "Alias for workspace.renameSymbol",
    category: "Refactor",
    keybinding: "Shift+F6",
    provenance: "provider",
    keywords: ["rename", "symbol"],
  },
  "workspace.safeDeleteSymbol":
  {
    id: "workspace.safeDeleteSymbol",
    title: "Safe Delete",
    description: "Check usages across workspace before deleting symbol",
    category: "Refactor",
    keybinding: "Alt+Delete",
    provenance: "provider",
    keywords: ["delete", "safe", "usages", "check"],
  },
  "workspace.safeDelete":
  {
    id: "workspace.safeDelete",
    title: "Safe Delete (Alias)",
    description: "Alias for workspace.safeDeleteSymbol",
    category: "Refactor",
    keybinding: "Alt+Delete",
    provenance: "provider",
    keywords: ["delete", "safe"],
  },
  "workspace.extractMethod":
  {
    id: "workspace.extractMethod",
    title: "Extract Method",
    description: "Extract selection into a new method or function",
    category: "Refactor",
    keybinding: "Ctrl+Alt+M",
    secondaryKeybindings: ["Meta+Alt+M", "Meta+Alt+m"],
    provenance: "provider",
    keywords: ["extract", "method", "function"],
  },
  "workspace.extractVariable":
  {
    id: "workspace.extractVariable",
    title: "Extract Variable",
    description: "Extract expression into a local variable",
    category: "Refactor",
    keybinding: "Ctrl+Alt+V",
    provenance: "provider",
    keywords: ["extract", "variable", "constant"],
  },
  "workspace.inline":
  {
    id: "workspace.inline",
    title: "Inline",
    description: "Inline method, variable, or constant at call sites",
    category: "Refactor",
    keybinding: "Ctrl+Alt+N",
    provenance: "provider",
    keywords: ["inline", "substitute"],
  },
  "workspace.changeSignature":
  {
    id: "workspace.changeSignature",
    title: "Change Signature",
    description: "Modify parameters, return type, and visibility of method",
    category: "Refactor",
    keybinding: "Ctrl+F6",
    provenance: "provider",
    keywords: ["signature", "parameters", "modify"],
  },
  "workspace.moveRefactor":
  {
    id: "workspace.moveRefactor",
    title: "Move…",
    description: "Move class, function, or file to another package or directory",
    category: "Refactor",
    keybinding: "F6",
    provenance: "provider",
    keywords: ["move", "refactor", "package"],
  },
  "workspace.codeActions":
  {
    id: "workspace.codeActions",
    title: "Show Intention Actions / Quick Fixes",
    description: "Show available quick fixes and intention actions at cursor",
    category: "Refactor",
    keybinding: "Alt+Enter",
    provenance: "provider",
    keywords: ["quick fix", "intention", "lightbulb", "action", "fix"],
  }
};
