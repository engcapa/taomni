import { type WorkspaceCommand } from "../workspaceCommands";
import { type WorkspaceTreeCommandPayload } from "../codeWorkspaceModel";
import { type WorkspaceCommandsContext } from "./types";


export type GitCommandsContext=Pick<WorkspaceCommandsContext,"intelligencePreferences"|"activeGitRoot"|"toggleInlineBlame"|"gitRootsLoading"|"onOpenGitManager"|"gitRoots"|"openGitManager"|"handleActivateToolWindow"|"selected"|"ignoreWorkspacePath">;

export function createGitCommands(controllerContext: GitCommandsContext): Record<string,WorkspaceCommand> {
  return {
    "workspace.toggleInlineBlame": {
      id: "workspace.toggleInlineBlame",
      title: `${controllerContext.intelligencePreferences.inlineBlameEnabled? "Disable":"Enable"} Inline Git Blame`,
      category: "Git",
      keywords: ["git","blame","author","line"],
      when: () => !!controllerContext.activeGitRoot,
      run: controllerContext.toggleInlineBlame,
    },
    "workspace.openGit": {
      id: "workspace.openGit",
      title: "Open in Git Tab",
      category: "Git",
      when: () => !controllerContext.gitRootsLoading&&!!controllerContext.onOpenGitManager&&controllerContext.gitRoots.length>0,
      run: controllerContext.openGitManager,
    },
    "workspace.gitToolWindow": {
      // ED-PARITY-018 DEC-018-01: IDEA Alt+9 = the Git tool window.
      id: "workspace.gitToolWindow",
      title: "Git Tool Window",
      category: "Git",
      keybinding: "Alt+9",
      keywords: ["git","log","changes","vcs"],
      run: () => controllerContext.handleActivateToolWindow("git"),
    },
    "workspace.commitToolWindow": {
      // ED-PARITY-018 DEC-018-02: IDEA Alt+0 = Commit (changes + message).
      id: "workspace.commitToolWindow",
      title: "Commit Tool Window",
      category: "Git",
      keybinding: "Alt+0",
      keywords: ["commit","changes","vcs"],
      run: () => controllerContext.handleActivateToolWindow("git"),
    },
    "workspace.tree.addToGitignore": {
      id: "workspace.tree.addToGitignore",
      title: "Add Tree Selection to .gitignore",
      category: "Git",
      keywords: ["git","ignore","exclude"],
      when: (context) => {
        const selection=(context.payload as WorkspaceTreeCommandPayload|undefined)?.selection??controllerContext.selected;
        return context.focus==="tree"&&(
          selection?.kind==="dir"
          ||(selection?.kind==="file"&&selection.ref.kind==="root")
        );
      },
      run: (context) => {
        const selection=(context.payload as WorkspaceTreeCommandPayload|undefined)?.selection??controllerContext.selected;
        if(selection?.kind==="dir") {
          void controllerContext.ignoreWorkspacePath(selection.rootId,selection.path,true);
        } else if(selection?.kind==="file"&&selection.ref.kind==="root") {
          void controllerContext.ignoreWorkspacePath(selection.ref.rootId,selection.ref.path,false);
        }
      },
    }
  };
}
