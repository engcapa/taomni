import { type WorkspaceCommand } from "../workspaceCommands";
import { type WorkspaceCommandsContext } from "./types";


export type DiffCommandsContext=Pick<WorkspaceCommandsContext,"activeFile"|"compareWithClipboard"|"compareWithFile"|"compareWithLocalHistory">;

export function createDiffCommands(controllerContext: DiffCommandsContext): Record<string,WorkspaceCommand> {
  return {
    "workspace.compareWithClipboard": {
      id: "workspace.compareWithClipboard",
      title: "Compare with Clipboard",
      category: "Diff",
      keywords: ["diff","compare","clipboard"],
      when: () => !!controllerContext.activeFile,
      run: controllerContext.compareWithClipboard,
    },
    "workspace.compareWithFile": {
      id: "workspace.compareWithFile",
      title: "Compare with File…",
      category: "Diff",
      keywords: ["diff","compare","file"],
      when: () => !!controllerContext.activeFile,
      run: controllerContext.compareWithFile,
    },
    "workspace.compareWithLocalHistory": {
      id: "workspace.compareWithLocalHistory",
      title: "Compare with Local History",
      category: "Diff",
      keywords: ["diff","compare","local","history","snapshot"],
      when: () => !!controllerContext.activeFile,
      run: controllerContext.compareWithLocalHistory,
    }
  };
}
