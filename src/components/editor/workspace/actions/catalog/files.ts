import { type WorkspaceActionMetadata } from "../types";

export const filesActionMetadata: Record<string, WorkspaceActionMetadata> = {
  "workspace.save":

  // --- File ---
  {
    id: "workspace.save",
    title: "Save Active File",
    description: "Save changes in the current editor tab to disk",
    category: "File",
    keybinding: "Ctrl+S",
    secondaryKeybindings: ["Meta+S"],
    provenance: "local",
    keywords: ["save", "write", "disk"],
  },
  "workspace.reload":
  {
    id: "workspace.reload",
    title: "Reload Active File",
    description: "Discard unsaved buffer changes and reload from disk",
    category: "File",
    provenance: "local",
    keywords: ["reload", "revert", "disk"],
  },
  "workspace.closeActiveEditorTab":
  {
    id: "workspace.closeActiveEditorTab",
    title: "Close Active Editor Tab",
    description: "Close the currently focused tab in the active editor group",
    category: "File",
    keybinding: "Ctrl+F4",
    provenance: "local",
    keywords: ["close", "tab"],
  },
  "workspace.refreshTree":
  {
    id: "workspace.refreshTree",
    title: "Refresh Project Tree",
    description: "Scan disk and refresh the project file tree",
    category: "File",
    provenance: "local",
    keywords: ["refresh", "tree", "reload"],
  },
  "workspace.tree.openLooseFile":
  {
    id: "workspace.tree.openLooseFile",
    title: "Open Loose File",
    description: "Open a standalone file outside workspace roots",
    category: "File",
    provenance: "local",
    keywords: ["open", "loose", "standalone"],
  },
  "workspace.tree.addFolder":
  {
    id: "workspace.tree.addFolder",
    title: "Add Folder to Workspace",
    description: "Add a new root folder into the current multi-root workspace",
    category: "File",
    provenance: "local",
    keywords: ["add", "folder", "root"],
  },
  "workspace.openGit":

  // --- Git ---
  {
    id: "workspace.openGit",
    title: "Open Git Manager",
    description: "Open full Git repository manager and version control panel",
    category: "Git",
    provenance: "local",
    keywords: ["git", "vcs", "branch", "commit", "log"],
  }
};
