import { loadAutoImportPreferences } from "../../../../lib/autoImportPreferences";
import { type WorkspaceCommand } from "../workspaceCommands";
import { type WorkspaceCommandsContext } from "./types";


export type EditingCommandsContext=Pick<WorkspaceCommandsContext,"executeEditorCommand"|"setSurroundWithDialogOpen"|"executePasteWithAutoImport"|"editorCommandStateFor"|"activeFile"|"lspFilesRef"|"copyReferenceAtCursor"|"clipboardHandle"|"setStatusMessage"|"setClipboardHistoryEntries"|"setClipboardHistoryOpen"|"toggleBookmarkAtCursor"|"chooseMnemonicBookmarkAtCursor"|"columnSelectionMode"|"toggleColumnSelectionMode"|"workspaceEditHistoryState"|"searchEverywhereOpen"|"requestWorkspaceUndoConfirmation"|"redoWorkspaceEdit">;

export function createEditingCommands(controllerContext: EditingCommandsContext): Record<string,WorkspaceCommand> {
  return {
    "editor.completeStatement": {
      id: "editor.completeStatement",
      title: "Complete Statement",
      category: "Edit",
      keybinding: "Ctrl+Shift+Enter",
      keywords: ["semicolon","finish","statement"],
      when: (context) => context.focus==="editor"&&!!context.hasActiveFile&&!context.readOnly,
      run: (context) => controllerContext.executeEditorCommand("completeStatement",context),
    },
    "editor.surroundWith": {
      // §8.19.8: one Surround With entry opens the kind dialog; try/catch is
      // no longer a hard-wired command and every kind shares the same
      // plan builder, single transaction and undo entry.
      id: "editor.surroundWith",
      title: "Surround With…",
      category: "Edit",
      keybinding: "Ctrl+Alt+T",
      // IDEA XWin lists Ctrl+Alt+Shift+B first (Ctrl+Alt+T opens a terminal on many desktops).
      keybindings: ["Ctrl+Alt+Shift+B","Meta+Alt+T"],
      keywords: ["surround","wrap","try","catch","if","while","runnable"],
      when: (context) => context.focus==="editor"&&!!context.hasActiveFile&&!context.readOnly,
      run: () => {
        controllerContext.setSurroundWithDialogOpen(true);
        return true;
      },
    },
    "editor.smartCompletion": {
      // §8.18.8 Smart completion stays visible but typed-unavailable until a
      // provider advertises expected types; it never relabels Basic results.
      id: "editor.smartCompletion",
      title: "Type-Matching Completion (Smart)",
      category: "Edit",
      provenance: "unsupported",
      keywords: ["smart","type matching","completion"],
      when: () => false,
      run: () => false,
    },
    "workspace.pasteWithAutoImport": {
      id: "workspace.pasteWithAutoImport",
      title: "Paste with Auto Import",
      category: "Edit",
      keywords: ["paste","auto import","paste with imports"],
      when: (context) => context.focus==="editor"&&!!context.hasActiveFile&&!context.readOnly,
      run: () => {
        void controllerContext.executePasteWithAutoImport();
        return true;
      },
    },
    "workspace.editor.copy": {
      id: "workspace.editor.copy",
      title: "Copy",
      category: "Edit",
      keybinding: "Ctrl+C",
      keybindings: ["Meta+C"],
      keywords: ["clipboard","selection","multi-caret"],
      when: (context) => context.focus==="editor"
        &&controllerContext.editorCommandStateFor(context)?.hasSelection===true,
      run: (context) => { controllerContext.executeEditorCommand("copy",context); },
    },
    "workspace.editor.cut": {
      id: "workspace.editor.cut",
      title: "Cut",
      category: "Edit",
      keybinding: "Ctrl+X",
      keybindings: ["Meta+X"],
      keywords: ["clipboard","selection","multi-caret"],
      when: (context) => {
        const state=controllerContext.editorCommandStateFor(context);
        return context.focus==="editor"&&!!state
          &&state.hasSelection&&!state.readOnly&&!state.composing;
      },
      run: (context) => { controllerContext.executeEditorCommand("cut",context); },
    },
    "workspace.editor.paste": {
      id: "workspace.editor.paste",
      title: "Paste",
      category: "Edit",
      keybinding: "Ctrl+V",
      keybindings: ["Meta+V"],
      keywords: ["clipboard","multi-caret","distribute"],
      when: (context) => {
        const state=controllerContext.editorCommandStateFor(context);
        return context.focus==="editor"&&!!state&&!state.readOnly&&!state.composing;
      },
      run: (context) => {
        const file=controllerContext.activeFile;
        if(file&&(file.languagePath.endsWith(".java")||controllerContext.lspFilesRef.current[file.key]?.status?.languageId==="java")) {
          const settings=loadAutoImportPreferences();
          if(settings.pasteImportMode!=="none") {
            void controllerContext.executePasteWithAutoImport();
            return;
          }
        }
        controllerContext.executeEditorCommand("paste",context);
      },
    },
    "workspace.editor.pasteAsPlainText": {
      // §8.19.5 Plain Paste: rectangular/segment metadata is dropped; the
      // plain text replaces the selection like any ordinary paste.
      id: "workspace.editor.pasteAsPlainText",
      title: "Paste as Plain Text",
      category: "Edit",
      keybinding: "Ctrl+Shift+Alt+V",
      keybindings: ["Meta+Shift+Alt+V"],
      keywords: ["clipboard","plain text","paste without formatting"],
      when: (context) => {
        const state=controllerContext.editorCommandStateFor(context);
        return context.focus==="editor"&&!!state&&!state.readOnly&&!state.composing;
      },
      run: (context) => { controllerContext.executeEditorCommand("pasteAsPlainText",context); },
    },
    "workspace.editor.copyReference": {
      // §8.19.5 Copy Reference: workspace-relative path:line, with a symbol
      // candidate only when the provider actually names one.
      id: "workspace.editor.copyReference",
      title: "Copy Reference",
      category: "Edit",
      keybinding: "Ctrl+Alt+Shift+C",
      keybindings: ["Meta+Alt+Shift+C"],
      keywords: ["copy reference","path line","qualified name","symbol"],
      when: (context) => context.focus==="editor"&&!!context.hasActiveFile,
      run: () => { void controllerContext.copyReferenceAtCursor(); },
    },
    "editor.pasteFromHistory": {
      // §8.19.5 Paste from History: session-only ring, searchable popup;
      // Enter dispatches the full segment plan at the caret as one undo.
      id: "editor.pasteFromHistory",
      title: "Paste from History…",
      category: "Edit",
      keybinding: "Ctrl+Shift+V",
      keybindings: ["Meta+Shift+V"],
      keywords: ["clipboard history","paste history","recent copies"],
      when: (context) => context.focus==="editor"&&!!context.hasActiveFile
        &&!context.readOnly,
      run: () => {
        const store=controllerContext.clipboardHandle;
        if(!store.isHistoryEnabled()||store.historyEntries().length===0) {
          controllerContext.setStatusMessage("Clipboard history is empty or disabled");
          return true;
        }
        controllerContext.setClipboardHistoryEntries([...store.historyEntries()]);
        controllerContext.setClipboardHistoryOpen(true);
        return true;
      },
    },
    "workspace.editor.moveStatementUp": {
      id: "workspace.editor.moveStatementUp",
      title: "Move Statement Up",
      category: "Edit",
      keybinding: "Ctrl+Shift+ArrowUp",
      keybindings: ["Meta+Shift+ArrowUp"],
      keywords: ["statement","line","syntax","move"],
      when: (context) => {
        const state=controllerContext.editorCommandStateFor(context);
        return context.focus==="editor"&&!!state&&!state.readOnly&&!state.composing;
      },
      run: (context) => { controllerContext.executeEditorCommand("moveStatementUp",context); },
    },
    "workspace.editor.moveStatementDown": {
      id: "workspace.editor.moveStatementDown",
      title: "Move Statement Down",
      category: "Edit",
      keybinding: "Ctrl+Shift+ArrowDown",
      keybindings: ["Meta+Shift+ArrowDown"],
      keywords: ["statement","line","syntax","move"],
      when: (context) => {
        const state=controllerContext.editorCommandStateFor(context);
        return context.focus==="editor"&&!!state&&!state.readOnly&&!state.composing;
      },
      run: (context) => { controllerContext.executeEditorCommand("moveStatementDown",context); },
    },
    "workspace.editor.cloneCaretAbove": {
      id: "workspace.editor.cloneCaretAbove",
      title: "Clone Caret Above",
      category: "Edit",
      keybinding: "Ctrl+Alt+Shift+ArrowUp",
      keywords: ["caret","cursor","multi-caret","above"],
      when: (context) => {
        const state=controllerContext.editorCommandStateFor(context);
        return context.focus==="editor"&&!!state&&!state.readOnly&&!state.composing;
      },
      run: (context) => { controllerContext.executeEditorCommand("cloneCaretAbove",context); },
    },
    "workspace.editor.cloneCaretBelow": {
      id: "workspace.editor.cloneCaretBelow",
      title: "Clone Caret Below",
      category: "Edit",
      keybinding: "Ctrl+Alt+Shift+ArrowDown",
      keywords: ["caret","cursor","multi-caret","below"],
      when: (context) => {
        const state=controllerContext.editorCommandStateFor(context);
        return context.focus==="editor"&&!!state&&!state.readOnly&&!state.composing;
      },
      run: (context) => { controllerContext.executeEditorCommand("cloneCaretBelow",context); },
    },
    "workspace.editor.collapseCarets": {
      id: "workspace.editor.collapseCarets",
      title: "Collapse Carets",
      category: "Edit",
      keybinding: "Escape",
      keywords: ["caret","selection","occurrence","escape"],
      when: (context) => {
        const state=controllerContext.editorCommandStateFor(context);
        return context.focus==="editor"&&!!state
          &&(state.caretCount>1||state.occurrenceSessionActive);
      },
      run: (context) => { controllerContext.executeEditorCommand("collapseCarets",context); },
    },
    "workspace.editor.selectNextOccurrence": {
      id: "workspace.editor.selectNextOccurrence",
      title: "Select Next Occurrence",
      category: "Edit",
      keybinding: "Alt+J",
      keywords: ["occurrence","caret","selection","next"],
      when: (context) => context.focus==="editor"
        &&!!controllerContext.editorCommandStateFor(context),
      run: (context) => { controllerContext.executeEditorCommand("selectNextOccurrence",context); },
    },
    "workspace.editor.selectAllOccurrences": {
      id: "workspace.editor.selectAllOccurrences",
      title: "Select All Occurrences",
      category: "Edit",
      keybinding: "Ctrl+Alt+Shift+J",
      keybindings: ["Meta+Alt+Shift+J"],
      keywords: ["occurrence","caret","selection","all"],
      when: (context) => context.focus==="editor"
        &&!!controllerContext.editorCommandStateFor(context),
      run: (context) => { controllerContext.executeEditorCommand("selectAllOccurrences",context); },
    },
    "workspace.editor.foldSelection": {
      id: "workspace.editor.foldSelection",
      title: "Fold Selection",
      category: "Edit",
      keybinding: "Ctrl+Period",
      keybindings: ["Meta+Period"],
      keywords: ["fold","selection","collapse"],
      when: (context) => context.focus==="editor"
        &&controllerContext.editorCommandStateFor(context)?.hasSelection===true,
      run: (context) => { controllerContext.executeEditorCommand("foldSelection",context); },
    },
    "workspace.editor.foldAll": {
      id: "workspace.editor.foldAll",
      title: "Fold All",
      category: "Edit",
      keybinding: "Ctrl+Shift+NumpadSubtract",
      keybindings: ["Ctrl+Shift+Minus"],
      keywords: ["fold","collapse","all"],
      when: (context) => context.focus==="editor"
        &&!!controllerContext.editorCommandStateFor(context),
      run: (context) => { controllerContext.executeEditorCommand("foldAll",context); },
    },
    "workspace.editor.unfoldAll": {
      id: "workspace.editor.unfoldAll",
      title: "Unfold All",
      category: "Edit",
      keybinding: "Ctrl+Shift+NumpadAdd",
      keybindings: ["Ctrl+Shift+Equal"],
      keywords: ["fold","expand","all"],
      when: (context) => context.focus==="editor"
        &&!!controllerContext.editorCommandStateFor(context),
      run: (context) => { controllerContext.executeEditorCommand("unfoldAll",context); },
    },
    "workspace.toggleBookmark": {
      id: "workspace.toggleBookmark",
      title: "Toggle Bookmark",
      category: "Edit",
      keybinding: "F11",
      keywords: ["bookmark","mark","line"],
      when: (context) => context.focus==="editor"&&!!controllerContext.activeFile&&!controllerContext.activeFile.loading,
      run: controllerContext.toggleBookmarkAtCursor,
    },
    "workspace.toggleBookmarkWithMnemonic": {
      id: "workspace.toggleBookmarkWithMnemonic",
      title: "Toggle Bookmark with Mnemonic",
      category: "Edit",
      keybinding: "Ctrl+F11",
      keywords: ["bookmark","mnemonic","mark","digit"],
      when: (context) => context.focus==="editor"&&!!controllerContext.activeFile&&!controllerContext.activeFile.loading,
      run: () => controllerContext.chooseMnemonicBookmarkAtCursor(),
    },
    "workspace.toggleColumnSelection": {
      id: "workspace.toggleColumnSelection",
      title: `${controllerContext.columnSelectionMode? "Disable":"Enable"} Column Selection Mode`,
      category: "Edit",
      keybinding: "Alt+Shift+Insert",
      keywords: ["rectangular","block selection","column mode"],
      when: (context) => context.focus==="editor"||context.focus==="workspace",
      run: controllerContext.toggleColumnSelectionMode,
    },
    "workspace.undoWorkspaceEdit": {
      id: "workspace.undoWorkspaceEdit",
      title: controllerContext.workspaceEditHistoryState.undoLabel
        ? `Undo ${controllerContext.workspaceEditHistoryState.undoLabel}`
        :"Undo Workspace Edit",
      category: "Edit",
      keybinding: "Ctrl+Z",
      keybindings: ["Cmd+Z"],
      keywords: ["undo","workspace edit","refactor"],
      // ED-AUDIT-008: inside the editor surface the shared document undo
      // (workspace.undo) owns Ctrl+Z and claims the journal through
      // claimWorkspaceHistory. The Actions popup owns its keys and can offer
      // workspace Undo even when its default snapshot points at that editor.
      when: (context) => context.focus!=="tree"
        &&context.focus!=="terminal"
        &&(context.focus!=="editor"||controllerContext.searchEverywhereOpen)
        &&controllerContext.workspaceEditHistoryState.canUndo
        &&!controllerContext.workspaceEditHistoryState.busy,
      run: () => controllerContext.requestWorkspaceUndoConfirmation(),
    },
    "workspace.redoWorkspaceEdit": {
      id: "workspace.redoWorkspaceEdit",
      title: controllerContext.workspaceEditHistoryState.redoLabel
        ? `Redo ${controllerContext.workspaceEditHistoryState.redoLabel}`
        :"Redo Workspace Edit",
      category: "Edit",
      keybinding: "Ctrl+Shift+Z",
      keybindings: ["Cmd+Shift+Z","Ctrl+Y","Cmd+Y"],
      keywords: ["redo","workspace edit","refactor"],
      when: (context) => context.focus!=="tree"
        &&context.focus!=="terminal"
        &&context.focus!=="editor"
        &&controllerContext.workspaceEditHistoryState.canRedo
        &&!controllerContext.workspaceEditHistoryState.busy,
      run: () => void controllerContext.redoWorkspaceEdit(),
    }
  };
}
