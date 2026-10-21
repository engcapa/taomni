import { evaluateDestructiveRefactorAvailability } from "../refactorPlan";
import { type WorkspaceCommand } from "../workspaceCommands";
import { type WorkspaceTreeCommandPayload } from "../codeWorkspaceModel";
import { type WorkspaceCommandsContext } from "./types";


export type RefactoringCommandsContext=Pick<WorkspaceCommandsContext,"activeFile"|"activeCapabilities"|"renameSymbolRef"|"safeDeleteSymbolRef"|"openRefactorActions"|"runExtractMethodRef"|"selected"|"renameSelected">;

export function createRefactoringCommands(controllerContext: RefactoringCommandsContext): Record<string,WorkspaceCommand> {
  return {
    "workspace.renameSymbol": {
      id: "workspace.renameSymbol",
      title: "Rename Symbol",
      category: "Refactor",
      keybinding: "Shift+F6",
      keywords: ["refactor","rename"],
      when: (context) => context.focus==="editor"&&!!controllerContext.activeFile&&!controllerContext.activeFile.loading
        &&(!controllerContext.activeCapabilities||!!controllerContext.activeCapabilities.rename),
      run: () => void controllerContext.renameSymbolRef.current(),
    },
    "workspace.safeDeleteSymbol": {
      id: "workspace.safeDeleteSymbol",
      title: "Safe Delete Symbol",
      category: "Refactor",
      keybinding: "Alt+Delete",
      keybindings: ["Alt-Delete","Alt-delete","Alt+Delete"],
      keywords: ["refactor","delete","safe delete","usages"],
      when: (context) => context.focus!=="tree"&&!!controllerContext.activeFile&&!controllerContext.activeFile.loading
        &&!controllerContext.activeFile.library,
      getState: () => {
        const availability=evaluateDestructiveRefactorAvailability(null);
        if(availability.state==="disabled") {
          return {
            availability: "disabled",
            disabledReason: availability.message,
            source: "provider",
            scope: "workspace",
            freshness: "current",
            completeness: "complete",
          };
        }
        return {
          availability: "available",
          source: "provider",
          scope: "workspace",
          freshness: "current",
          completeness: "complete",
        };
      },
      run: () => void controllerContext.safeDeleteSymbolRef.current(),
    },
    "workspace.refactorThis": {
      id: "workspace.refactorThis",
      title: "Refactor This…",
      category: "Refactor",
      keybinding: "Ctrl+Alt+Shift+T",
      keybindings: ["Meta+Alt+Shift+T","Meta+Alt+Shift+t","Ctrl+T"],
      keywords: ["refactor","refactor this","extract","inline","rename","move"],
      when: (context) => context.focus!=="tree"&&!!controllerContext.activeFile&&!controllerContext.activeFile.loading
        &&!controllerContext.activeFile.library&&!!controllerContext.activeCapabilities?.codeAction,
      run: () => void controllerContext.openRefactorActions(["refactor"],"Refactor actions"),
    },
    "workspace.extractMethod": {
      id: "workspace.extractMethod",
      title: "Extract Method",
      category: "Refactor",
      keybinding: "Ctrl+Alt+M",
      // Keep the native Ctrl chord while giving macOS an explicit, parser-
      // compatible Command alias. The action host uses '+'-delimited bindings.
      keybindings: ["Meta+Alt+M","Meta+Alt+m"],
      keywords: ["refactor","extract","method","function"],
      when: (context) => context.focus!=="tree"&&!!controllerContext.activeFile&&!controllerContext.activeFile.loading
        &&!controllerContext.activeFile.library,
      run: () => void controllerContext.runExtractMethodRef.current(),
    },
    "workspace.extractVariable": {
      id: "workspace.extractVariable",
      title: "Extract Variable",
      category: "Refactor",
      keybinding: "Ctrl+Alt+V",
      keybindings: ["Mod-Alt-V","Mod-Alt-v"],
      keywords: ["refactor","extract","variable","local"],
      when: (context) => context.focus!=="tree"&&!!controllerContext.activeFile&&!controllerContext.activeFile.loading
        &&!controllerContext.activeFile.library&&!!controllerContext.activeCapabilities?.codeAction,
      run: () => void controllerContext.openRefactorActions(["refactor.extract.variable","refactor.extract.constant"],"Extract Variable/Constant actions"),
    },
    "workspace.inline": {
      id: "workspace.inline",
      title: "Inline",
      category: "Refactor",
      keybinding: "Ctrl+Alt+N",
      keybindings: ["Mod-Alt-N","Mod-Alt-n"],
      keywords: ["refactor","inline","variable","method","function"],
      when: (context) => context.focus!=="tree"&&!!controllerContext.activeFile&&!controllerContext.activeFile.loading
        &&!controllerContext.activeFile.library&&!!controllerContext.activeCapabilities?.codeAction,
      run: () => void controllerContext.openRefactorActions(["refactor.inline"],"Inline actions"),
    },
    "workspace.changeSignature": {
      id: "workspace.changeSignature",
      title: "Change Signature",
      category: "Refactor",
      keybinding: "Ctrl+F6",
      keybindings: ["Mod-F6"],
      keywords: ["refactor","signature","parameters","arguments"],
      when: (context) => context.focus!=="tree"&&!!controllerContext.activeFile&&!controllerContext.activeFile.loading
        &&!controllerContext.activeFile.library&&!!controllerContext.activeCapabilities?.codeAction,
      run: () => void controllerContext.openRefactorActions(["refactor.rewrite.changeSignature","refactor.changeSignature"],"Change Signature actions"),
    },
    "workspace.moveRefactor": {
      id: "workspace.moveRefactor",
      title: "Move",
      category: "Refactor",
      keybinding: "F6",
      keywords: ["refactor","move","symbol","class"],
      when: (context) => context.focus!=="tree"&&!!controllerContext.activeFile&&!controllerContext.activeFile.loading
        &&!controllerContext.activeFile.library&&!!controllerContext.activeCapabilities?.codeAction,
      run: () => void controllerContext.openRefactorActions(["refactor.move","refactor.rewrite"],"Move actions"),
    },
    "workspace.tree.rename": {
      id: "workspace.tree.rename",
      title: "Rename Tree Selection",
      category: "Refactor",
      keybinding: "F2",
      when: (context) => context.focus==="tree"&&!!((context.payload as WorkspaceTreeCommandPayload|undefined)?.selection??controllerContext.selected),
      run: (context) => {
        const payload=context.payload as WorkspaceTreeCommandPayload|undefined;
        void controllerContext.renameSelected(payload?.selection);
      },
    }
  };
}
