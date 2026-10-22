import { type WorkspaceCommand } from "../workspaceCommands";
import { type WorkspaceTreeCommandPayload } from "../codeWorkspaceModel";
import { type WorkspaceCommandsContext } from "./types";


export type SearchCommandsContext=Pick<WorkspaceCommandsContext,"openFindInFiles"|"structuralSearch"|"findInDirectory">;

export function createSearchCommands(controllerContext: SearchCommandsContext): Record<string,WorkspaceCommand> {
  return {
    "workspace.findInFiles": {
      id: "workspace.findInFiles",
      title: "Find in Files",
      category: "Search",
      keybinding: "Ctrl+Shift+F",
      // macOS uses Command for the workspace-wide search chord.
      keybindings: ["Meta+Shift+F"],
      keywords: ["text","content","grep"],
      run: () => controllerContext.openFindInFiles(),
    },
    "workspace.replaceInFiles": {
      id: "workspace.replaceInFiles",
      title: "Replace in Files",
      category: "Search",
      keybinding: "Ctrl+Shift+R",
      keybindings: ["Meta+Shift+R"],
      keywords: ["bulk replace"],
      run: () => {
        controllerContext.openFindInFiles("replace");
      },
    },
    "workspace.searchStructurally": {
      id: "workspace.searchStructurally",
      title: "Search Structurally…",
      category: "Search",
      keywords: ["structural","ssr","template","ast"],
      run: () => controllerContext.structuralSearch.open(),
    },
    "workspace.tree.findInDirectory": {
      id: "workspace.tree.findInDirectory",
      title: "Find in Selected Directory",
      category: "Search",
      when: (context) => context.focus==="tree",
      run: (context) => {
        const payload=context.payload as WorkspaceTreeCommandPayload|undefined;
        controllerContext.findInDirectory(payload?.path??"");
      },
    }
  };
}
