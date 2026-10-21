import { type WorkspaceActionMetadata } from "../types";

export const executionActionMetadata: Record<string, WorkspaceActionMetadata> = {
  "workspace.runContextConfiguration":

  // --- Run & Build ---
  {
    id: "workspace.runContextConfiguration",
    title: "Run Context Configuration",
    description: "Execute the main target or test associated with the active file",
    category: "Run",
    keybinding: "Ctrl+Shift+F10",
    provenance: "local",
    keywords: ["run", "execute", "launch", "context"],
  },
  "workspace.buildProject":
  {
    id: "workspace.buildProject",
    title: "Build Project",
    description: "Build or compile all modules in active workspace",
    category: "Build",
    keybinding: "Ctrl+F9",
    provenance: "local",
    keywords: ["build", "compile", "make", "project"],
  },
  "workspace.recompileActiveFile":
  {
    id: "workspace.recompileActiveFile",
    title: "Recompile Active File",
    description: "Trigger incremental recompile of the active file or module",
    category: "Build",
    keybinding: "Ctrl+Shift+F9",
    provenance: "local",
    keywords: ["compile", "build", "recompile", "single file"],
  },
  "workspace.showRunTasks":
  {
    id: "workspace.showRunTasks",
    title: "Show Run Tasks",
    description: "Open the Run tasks dock panel",
    category: "Run",
    keybinding: "Alt+4",
    provenance: "local",
    keywords: ["run", "tasks", "scripts"],
  },
  "workspace.rerunLastTask":
  {
    id: "workspace.rerunLastTask",
    title: "Rerun Last Task",
    description: "Rerun the most recently executed workspace task",
    category: "Run",
    keybinding: "Ctrl+F5",
    provenance: "local",
    keywords: ["rerun", "repeat", "last task"],
  }
};
