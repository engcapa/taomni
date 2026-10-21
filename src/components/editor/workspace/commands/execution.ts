import { type WorkspaceCommand } from "../workspaceCommands";
import { type WorkspaceCommandsContext } from "./types";


export type ExecutionCommandsContext=Pick<WorkspaceCommandsContext,"activeFile"|"runActiveJavaFileRef"|"roots"|"buildActiveProjectRef"|"recompileActiveFileRef"|"handleActivateToolWindow"|"setBottomDockTab"|"setBottomDockOpen"|"runPanelRef"|"setStatusMessage"|"coverageReport"|"scanWorkspaceCoverage">;

export function createExecutionCommands(controllerContext: ExecutionCommandsContext): Record<string,WorkspaceCommand> {
  return {
    "workspace.runActiveJavaFile": {
      id: "workspace.runActiveJavaFile",
      title: "Run Current Target",
      category: "Run",
      keybinding: "Shift+F10",
      keybindings: ["Ctrl+Shift+F10"],
      keywords: ["target","main","run","application"],
      when: () => !!controllerContext.activeFile
        &&controllerContext.activeFile.ref.kind==="root"
        &&!controllerContext.activeFile.library,
      run: () => controllerContext.runActiveJavaFileRef.current(),
    },
    "workspace.runContextConfiguration": {
      id: "workspace.runContextConfiguration",
      title: "Run Context Configuration",
      category: "Run",
      keybinding: "Ctrl+Shift+F10",
      keybindings: ["Mod-Shift-F10"],
      keywords: ["run context","run file","main","test","target"],
      when: () => !!controllerContext.activeFile
        &&controllerContext.activeFile.ref.kind==="root"
        &&!controllerContext.activeFile.library,
      run: () => controllerContext.runActiveJavaFileRef.current(),
    },
    "workspace.buildProject": {
      id: "workspace.buildProject",
      title: "Build Project",
      category: "Build",
      keybinding: "Ctrl+F9",
      keywords: ["build","compile","maven","gradle"],
      when: () => controllerContext.roots.length>0,
      run: () => controllerContext.buildActiveProjectRef.current(false),
    },
    "workspace.recompileActiveFile": {
      id: "workspace.recompileActiveFile",
      title: controllerContext.activeFile? `Recompile '${controllerContext.activeFile.title}'`:"Recompile Active File",
      category: "Build",
      keybinding: "Ctrl+Shift+F9",
      keybindings: ["Mod-Shift-F9"],
      keywords: ["compile","recompile","single file","build","javac"],
      when: () => !!controllerContext.activeFile&&!controllerContext.activeFile.library,
      run: () => controllerContext.recompileActiveFileRef.current(),
    },
    "workspace.showRunTasks": {
      id: "workspace.showRunTasks",
      title: "Show Run Tasks",
      category: "Run",
      keybinding: "Alt+4",
      keywords: ["run","task","script"],
      run: () => controllerContext.handleActivateToolWindow("run"),
    },
    "workspace.showAnalysis": {
      id: "workspace.showAnalysis",
      title: "Show Code Analysis",
      category: "Analyze",
      keywords: ["inspection","data flow","diagnostics","lsp","psi"],
      run: () => {
        controllerContext.setBottomDockTab("analysis");
        controllerContext.setBottomDockOpen(true);
      },
    },
    "workspace.rerunLastTask": {
      id: "workspace.rerunLastTask",
      title: "Rerun Last Task",
      category: "Run",
      keybinding: "Ctrl+F5",
      keywords: ["run","rerun","repeat"],
      run: () => {
        if(!controllerContext.runPanelRef.current?.rerunLast()) controllerContext.setStatusMessage("No workspace task has run yet");
      },
    },
    "workspace.showCoverage": {
      id: "workspace.showCoverage",
      title: "Show Code Coverage",
      category: "Analyze",
      keywords: ["coverage","jacoco","lcov","tests","lines"],
      run: () => {
        controllerContext.setBottomDockTab("coverage");
        controllerContext.setBottomDockOpen(true);
        if(!controllerContext.coverageReport) void controllerContext.scanWorkspaceCoverage();
      },
    }
  };
}
