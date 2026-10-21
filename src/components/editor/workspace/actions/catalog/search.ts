import { type WorkspaceActionMetadata } from "../types";

export const searchActionMetadata: Record<string, WorkspaceActionMetadata> = {
  "workspace.findInFiles":

  // --- Search ---
  {
    id: "workspace.findInFiles",
    title: "Find in Files",
    description: "Search text across the whole workspace with regex and filters",
    category: "Search",
    keybinding: "Ctrl+Shift+F",
    secondaryKeybindings: ["Meta+Shift+F"],
    provenance: "local",
    keywords: ["find", "search", "grep", "files"],
  },
  "workspace.replaceInFiles":
  {
    id: "workspace.replaceInFiles",
    title: "Replace in Files",
    description: "Replace text across multiple files with preview",
    category: "Search",
    keybinding: "Ctrl+Shift+R",
    secondaryKeybindings: ["Meta+Shift+R"],
    provenance: "local",
    keywords: ["replace", "substitute", "files"],
  },
  "workspace.searchStructurally":
  {
    id: "workspace.searchStructurally",
    title: "Search Structurally…",
    description: "Find Java code by AST template (tree-sitter parser; no text fallback)",
    category: "Search",
    provenance: "index",
    keywords: ["structural", "ssr", "template", "ast", "pattern"],
  }
};
