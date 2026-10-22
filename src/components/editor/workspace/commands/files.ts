import { workspaceFileIdentity } from "../workspaceRecovery";
import { resolveReopenLocation } from "../workspaceTabPolicy";
import { openSettingsSection } from "../../../../lib/settingsNavigation";
import { listRefactorRecoveryJournalsV2,isPendingRefactorRecoveryEntry } from "../refactorPlan";
import { type WorkspaceCommand } from "../workspaceCommands";
import { type WorkspaceTreeCommandPayload,errorMessage } from "../codeWorkspaceModel";
import { type WorkspaceCommandsContext } from "./types";


export type FilesCommandsContext=Pick<WorkspaceCommandsContext,"closedTabsStack"|"workspaceUi"|"activeEditorGroupId"|"setClosedTabsStack"|"openFile"|"openFilesRef"|"setStatusMessage"|"roots"|"promptRefactorRecoveryEntry"|"workspaceInstanceId"|"activeKeyRef"|"saveFile"|"activeKey"|"closeFile"|"activeFile"|"reloadFile"|"refreshTree"|"openLooseFile"|"addRoot"|"treeContextMenuSessionRef"|"selected"|"requestTreeOpen"|"selectedRootDirectory"|"createFile"|"createDir"|"openNewJavaClassDialog"|"deleteSelected"|"copyTreePath">;

export function createFilesCommands(controllerContext: FilesCommandsContext): Record<string,WorkspaceCommand> {
  return {
    "workspace.reopenClosedTab": {
      id: "workspace.reopenClosedTab",
      title: "Reopen Closed Tab",
      category: "File",
      keybinding: "Ctrl+Shift+T",
      keywords: ["reopen","closed","tab","undo close"],
      run: () => {
        // §8.18.5: pop the newest entry that still resolves to a real file.
        // §8.19.6: resolve against the LIVE tree — original leaf, then the
        // nearest surviving ancestor along the recorded route, then the leaf
        // owning the most former siblings, then the active editor.
        while(controllerContext.closedTabsStack.length>0) {
          const [entry,...rest]=controllerContext.closedTabsStack;
          const resolution=entry?.ref&&entry.location
            ? resolveReopenLocation(controllerContext.workspaceUi.layoutTreeV2,entry.location,controllerContext.activeEditorGroupId)
            :null;
          controllerContext.setClosedTabsStack(rest);
          if(entry&&entry.ref) {
            const openPromise=controllerContext.openFile(
              entry.ref as never,
              resolution? { groupId: resolution.leafId }:undefined,
            );
            void openPromise.then(() => {
              const opened=Object.values(controllerContext.openFilesRef.current).some((candidate) => (
                workspaceFileIdentity(candidate.ref)===entry.fileIdentity
                &&!candidate.loading
                &&!candidate.error
              ));
              if(opened&&resolution?.kind==="relocated") {
                controllerContext.setStatusMessage(
                  resolution.reason==="route"
                    ? `Reopened ${entry.title} in the nearest surviving split`
                    :resolution.reason==="sibling"
                      ? `Reopened ${entry.title} next to its former tab group`
                      :`Reopened ${entry.title} in the active editor`,
                );
              }
            }).catch((error) => controllerContext.setStatusMessage(errorMessage(error)));
            return true;
          }
        }
        controllerContext.setStatusMessage("No recently closed tab to reopen");
        return false;
      },
    },
    "workspace.showSettings": {
      id: "workspace.showSettings",
      title: "Settings…",
      category: "File",
      keybinding: "Ctrl+Alt+S",
      platformKeybindings: { mac: ["Meta+,","Ctrl+Alt+S"] },
      keywords: ["settings","preferences","options"],
      when: (context) => context.focus!=="terminal"&&context.focus!=="modal",
      run: () => openSettingsSection("general"),
    },
    "workspace.reviewRefactorRecovery": {
      id: "workspace.reviewRefactorRecovery",
      title: "Review Refactor Recovery Entries",
      category: "File",
      keywords: ["recovery","restore","refactor","repair"],
      run: async () => {
        const rootPath=controllerContext.roots[0]?.path;
        if(!rootPath) return;
        const listing=listRefactorRecoveryJournalsV2(rootPath);
        const pending=listing.entries.filter(isPendingRefactorRecoveryEntry);
        if(pending.length===0) {
          controllerContext.setStatusMessage("No pending recovery entries found");
          return;
        }
        for(const entry of pending) {
          await controllerContext.promptRefactorRecoveryEntry(entry,controllerContext.workspaceInstanceId);
        }
      },
    },
    "workspace.save": {
      id: "workspace.save",
      title: "Save Active File",
      category: "File",
      keybinding: "Ctrl+S",
      keybindings: ["Meta+S"],
      when: () => {
        const file=controllerContext.openFilesRef.current[controllerContext.activeKeyRef.current??""];
        return !!file?.dirty&&!file.loading&&!file.saving;
      },
      run: () => void controllerContext.saveFile(controllerContext.activeKeyRef.current),
    },
    "workspace.closeActiveEditorTab": {
      id: "workspace.closeActiveEditorTab",
      title: "Close Active Editor Tab",
      category: "File",
      keybinding: "Ctrl+F4",
      when: () => !!controllerContext.activeKey,
      run: () => {
        if(controllerContext.activeKey) void controllerContext.closeFile(controllerContext.activeKey,controllerContext.activeEditorGroupId);
      },
    },
    "workspace.reload": {
      id: "workspace.reload",
      title: "Reload Active File",
      category: "File",
      when: () => !!controllerContext.activeFile&&!controllerContext.activeFile.loading,
      run: () => void controllerContext.reloadFile(),
    },
    "workspace.refreshTree": {
      id: "workspace.refreshTree",
      title: "Refresh Project Tree",
      category: "File",
      run: controllerContext.refreshTree,
    },
    "workspace.tree.openLooseFile": {
      id: "workspace.tree.openLooseFile",
      title: "Open Loose File",
      category: "File",
      run: () => void controllerContext.openLooseFile(),
    },
    "workspace.tree.addFolder": {
      id: "workspace.tree.addFolder",
      title: "Add Folder to Workspace",
      category: "File",
      run: () => void controllerContext.addRoot(),
    },
    "workspace.tree.open": {
      id: "workspace.tree.open",
      title: "Open Selected File",
      category: "File",
      when: (context) => context.focus==="tree",
      run: (context) => {
        if(controllerContext.treeContextMenuSessionRef.current) {
          controllerContext.treeContextMenuSessionRef.current.consumed=true;
        }
        const payload=context.payload as WorkspaceTreeCommandPayload|undefined;
        const selection=payload?.selection??controllerContext.selected;
        if(selection?.kind==="file") void controllerContext.requestTreeOpen(selection.ref);
      },
    },
    "workspace.tree.newFile": {
      id: "workspace.tree.newFile",
      title: "New File",
      category: "File",
      when: (context) => context.focus!=="tree"||!!controllerContext.selectedRootDirectory,
      run: (context) => {
        const payload=context.payload as WorkspaceTreeCommandPayload|undefined;
        void controllerContext.createFile(payload?.directory);
      },
    },
    "workspace.tree.newDirectory": {
      id: "workspace.tree.newDirectory",
      title: "New Directory",
      category: "File",
      when: (context) => context.focus!=="tree"||!!controllerContext.selectedRootDirectory,
      run: (context) => {
        const payload=context.payload as WorkspaceTreeCommandPayload|undefined;
        void controllerContext.createDir(payload?.directory);
      },
    },
    "workspace.tree.newJavaClass": {
      id: "workspace.tree.newJavaClass",
      title: "New Java Class...",
      category: "File",
      when: (context) => context.focus!=="tree"||!!controllerContext.selectedRootDirectory,
      run: (context) => {
        const payload=context.payload as WorkspaceTreeCommandPayload|undefined;
        controllerContext.openNewJavaClassDialog(payload?.directory);
      },
    },
    "workspace.tree.delete": {
      id: "workspace.tree.delete",
      title: "Delete or Remove Tree Selection",
      category: "File",
      keybinding: "Delete",
      when: (context) => context.focus==="tree"&&!!((context.payload as WorkspaceTreeCommandPayload|undefined)?.selection??controllerContext.selected),
      run: (context) => {
        const payload=context.payload as WorkspaceTreeCommandPayload|undefined;
        void controllerContext.deleteSelected(payload?.selection);
      },
    },
    "workspace.tree.copyPath": {
      id: "workspace.tree.copyPath",
      title: "Copy Absolute Path",
      category: "File",
      when: (context) => context.focus==="tree",
      run: (context) => {
        const payload=context.payload as WorkspaceTreeCommandPayload|undefined;
        if(payload?.rootId!==undefined&&payload.path!==undefined) {
          void controllerContext.copyTreePath(payload.rootId,payload.path,true);
        }
      },
    },
    "workspace.tree.copyRelativePath": {
      id: "workspace.tree.copyRelativePath",
      title: "Copy Relative Path",
      category: "File",
      when: (context) => context.focus==="tree",
      run: (context) => {
        const payload=context.payload as WorkspaceTreeCommandPayload|undefined;
        if(payload?.rootId!==undefined&&payload.path!==undefined) {
          void controllerContext.copyTreePath(payload.rootId,payload.path,false);
        }
      },
    }
  };
}
