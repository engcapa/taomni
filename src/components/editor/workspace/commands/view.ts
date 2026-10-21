import { selectCodeWorkspaceUi,useCodeWorkspaceStore } from "../../../../stores/codeWorkspaceStore";
import { isDocCommentRenderingSupported } from "../renderedDocCommentsModel";
import { type WorkspaceCommand } from "../workspaceCommands";
import { type WorkspaceCommandsContext } from "./types";


export type ViewCommandsContext=Pick<WorkspaceCommandsContext,"setCodeStyleSettingsOpen"|"setEditorAppearanceSettingsOpen"|"openTabPolicySettings"|"languagePanelOpen"|"handleActivateToolWindow"|"handleReturnToEditor"|"handleRestoreToolWindowLayout"|"jumpToLastToolWindow"|"hideActiveToolWindow"|"toggleAllToolWindows"|"toggleTodosPane"|"openTodosPane"|"bookmarks"|"setStatusMessage"|"jumpToMnemonicBookmark"|"activeFile"|"activeRenderedDocLanguageId"|"toggleRenderedDocComments"|"intelligencePreferences"|"toggleInlayHints"|"activeInlayHintsEnabled"|"activeLanguageId"|"activeCapabilities"|"toggleInlayHintsForActiveLanguage"|"activeFileSoftWrap"|"toggleSoftWrap"|"workspaceInstanceId"|"setBottomDockOpen"|"setBottomDockTab"|"terminalDockRef"|"splitOrientation"|"setSyncSplitScroll"|"activeKey"|"splitEditor"|"goToAdjacentSplit"|"moveActiveTabToAdjacentSplit"|"equalizeActiveSplitRatios"|"stretchActiveSplit"|"unsplitAllWindows">;

export function createViewCommands(controllerContext: ViewCommandsContext): Record<string,WorkspaceCommand> {
  return {
    "workspace.codeStyleSettings": {
      // §8.19.9 R8-D1: scheme management surface (copy/rename/delete/reset +
      // provenance); the active scheme feeds effective-style resolution.
      id: "workspace.codeStyleSettings",
      title: "Code Style Settings",
      category: "View",
      keywords: ["code style","scheme","indent","spaces","end of line"],
      run: () => {
        controllerContext.setCodeStyleSettingsOpen(true);
        return true;
      },
    },
    "workspace.editorAppearanceSettings": {
      id: "workspace.editorAppearanceSettings",
      title: "Editor Appearance Settings",
      category: "View",
      keywords: ["font","theme","contrast","wrap","breadcrumbs","virtual space","zoom"],
      run: () => controllerContext.setEditorAppearanceSettingsOpen(true),
    },
    "workspace.editorTabPolicySettings": {
      id: "workspace.editorTabPolicySettings",
      title: "Editor Tab Policy Settings",
      category: "View",
      keywords: ["tab","policy","limit","pinned","preview","order","activate"],
      run: () => controllerContext.openTabPolicySettings(),
    },
    "workspace.toggleProjectTree": {
      id: "workspace.toggleProjectTree",
      title: controllerContext.languagePanelOpen? "Hide Project Tree":"Show Project Tree",
      category: "View",
      keybinding: "Alt+1",
      // IDEA macOS keymap: Cmd+1 activates Project (Option+1 kept as alias).
      platformKeybindings: { mac: ["Meta+1","Alt+1"] },
      keywords: ["project","explorer","files","tree","sidebar","collapse"],
      run: () => controllerContext.handleActivateToolWindow("project"),
    },
    "workspace.activateToolWindow": {
      id: "workspace.activateToolWindow",
      title: "Activate Tool Window",
      category: "View",
      keywords: ["tool","window","panel","dock","activate"],
      run: (context) => {
        const payload=context.payload as { toolId?: string; }|undefined;
        const toolId=payload?.toolId??"project";
        controllerContext.handleActivateToolWindow(toolId);
      },
    },
    "workspace.returnToEditor": {
      id: "workspace.returnToEditor",
      title: "Focus Editor",
      category: "View",
      keybinding: "Escape",
      keywords: ["focus","editor","escape","return"],
      when: (context) => context.focus!=="editor"&&context.focus!=="modal"&&context.focus!=="search"&&context.focus!=="completion"&&context.focus!=="snippet",
      run: controllerContext.handleReturnToEditor,
    },
    "workspace.restoreToolWindowLayout": {
      id: "workspace.restoreToolWindowLayout",
      title: "Restore Default Layout",
      category: "View",
      keybinding: "Shift+F12",
      keywords: ["layout","restore","default","tool","window","reset"],
      run: controllerContext.handleRestoreToolWindowLayout,
    },
    "workspace.jumpToLastToolWindow": {
      id: "workspace.jumpToLastToolWindow",
      title: "Jump to Last Tool Window",
      category: "View",
      keybinding: "F12",
      keywords: ["tool window","last","focus","f12"],
      when: (context) => context.focus!=="modal",
      run: controllerContext.jumpToLastToolWindow,
    },
    "workspace.hideActiveToolWindow": {
      id: "workspace.hideActiveToolWindow",
      title: "Hide Active Tool Window",
      category: "View",
      keybinding: "Shift+Escape",
      keywords: ["tool window","hide","close","escape"],
      when: (context) => context.focus!=="modal"&&context.focus!=="completion"&&context.focus!=="snippet",
      run: () => controllerContext.hideActiveToolWindow(),
    },
    "workspace.hideAllToolWindows": {
      id: "workspace.hideAllToolWindows",
      title: "Hide All Tool Windows",
      category: "View",
      keybinding: "Ctrl+Shift+F12",
      keywords: ["tool windows","hide","maximize editor","restore"],
      when: (context) => context.focus!=="modal",
      run: controllerContext.toggleAllToolWindows,
    },
    "workspace.showProblems": {
      id: "workspace.showProblems",
      title: "Problems",
      category: "View",
      keybinding: "Alt+6",
      keywords: ["problems","errors","warnings","diagnostics","inspections"],
      run: () => controllerContext.handleActivateToolWindow("problems"),
    },
    "workspace.toggleDocumentationPane": {
      id: "workspace.toggleDocumentationPane",
      title: "Toggle Outline Pane",
      category: "View",
      // IDEA Alt+7 = Structure tool window: show and activate it, or hide
      // it when it is already the active tool window.
      keybinding: "Alt+7",
      keywords: ["right","outline","structure","symbols"],
      run: () => controllerContext.handleActivateToolWindow("structure"),
    },
    "workspace.toggleTodosPane": {
      id: "workspace.toggleTodosPane",
      title: "Toggle TODOs / Bookmarks",
      category: "View",
      // IDEA Alt+2 = Bookmarks tool window.
      keybinding: "Alt+2",
      keywords: ["todo","fixme","bookmark","markers"],
      run: controllerContext.toggleTodosPane,
    },
    "workspace.showBookmarks": {
      id: "workspace.showBookmarks",
      title: "Show Bookmarks",
      category: "View",
      keybinding: "Shift+F11",
      keywords: ["bookmark","list","show"],
      run: controllerContext.openTodosPane,
    },
    "workspace.jumpToMnemonicBookmark": {
      id: "workspace.jumpToMnemonicBookmark",
      title: "Jump to Mnemonic Bookmark",
      category: "View",
      keywords: ["bookmark","jump","mnemonic","go"],
      run: () => {
        const mnemonicBookmarks=controllerContext.bookmarks.filter((b) => b.mnemonic);
        if(mnemonicBookmarks.length===0) {
          controllerContext.setStatusMessage("No mnemonic bookmarks set");
          return;
        }
        if(mnemonicBookmarks.length===1&&mnemonicBookmarks[0].mnemonic) {
          controllerContext.jumpToMnemonicBookmark(mnemonicBookmarks[0].mnemonic);
        } else {
          controllerContext.openTodosPane();
        }
      },
    },
    "workspace.toggleRenderedDocComments": {
      id: "workspace.toggleRenderedDocComments",
      title: "Toggle Rendered Documentation",
      category: "View",
      keybinding: "Ctrl+Alt+Q",
      keywords: ["doc","render","documentation","reader","comment","jsdoc","javadoc"],
      when: () => !!controllerContext.activeFile&&isDocCommentRenderingSupported(controllerContext.activeRenderedDocLanguageId),
      run: controllerContext.toggleRenderedDocComments,
    },
    "workspace.toggleInlayHints": {
      id: "workspace.toggleInlayHints",
      title: `${controllerContext.intelligencePreferences.inlayHintsEnabled? "Disable":"Enable"} Inlay Hints`,
      category: "View",
      keywords: ["inlay","hints","types","parameters"],
      run: controllerContext.toggleInlayHints,
    },
    "workspace.toggleLanguageInlayHints": {
      id: "workspace.toggleLanguageInlayHints",
      title: `${controllerContext.activeInlayHintsEnabled? "Disable":"Enable"} Inlay Hints for ${controllerContext.activeLanguageId??"Current Language"}`,
      category: "View",
      keywords: ["inlay","language","hints"],
      when: () => !!controllerContext.activeCapabilities?.inlayHint,
      run: controllerContext.toggleInlayHintsForActiveLanguage,
    },
    "workspace.toggleSoftWrap": {
      id: "workspace.toggleSoftWrap",
      title: `${controllerContext.activeFileSoftWrap? "Disable":"Enable"} Soft Wrap`,
      category: "View",
      keywords: ["wrap","long lines","line wrapping"],
      when: (context) => context.focus==="editor"||context.focus==="workspace",
      run: controllerContext.toggleSoftWrap,
    },
    "workspace.toggleTerminal": {
      id: "workspace.toggleTerminal",
      title: "Toggle Workspace Terminal",
      category: "View",
      keybinding: "Alt+F12",
      keywords: ["terminal","shell","bottom"],
      run: () => {
        const ui=selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(),controllerContext.workspaceInstanceId);
        if(ui.bottomDockOpen&&ui.bottomDockTab==="terminal") {
          controllerContext.setBottomDockOpen(false);
        } else {
          controllerContext.setBottomDockTab("terminal");
          controllerContext.setBottomDockOpen(true);
          controllerContext.terminalDockRef.current?.focus();
        }
      },
    },
    "workspace.toggleSyncSplitScroll": {
      id: "workspace.toggleSyncSplitScroll",
      title: "View: Toggle Synchronized Split Scrolling",
      category: "View",
      when: () => !!controllerContext.splitOrientation,
      run: () => {
        controllerContext.setSyncSplitScroll((v) => {
          const next=!v;
          controllerContext.setStatusMessage(next? "Synchronized split scrolling enabled":"Synchronized split scrolling disabled");
          return next;
        });
      },
    },
    "workspace.splitRight": {
      id: "workspace.splitRight",
      title: "Split Editor Right",
      category: "View",
      keywords: ["split","vertical","editor"],
      when: () => !!controllerContext.activeKey,
      run: () => {
        controllerContext.splitEditor("vertical");
        return true;
      },
    },
    "workspace.splitDown": {
      id: "workspace.splitDown",
      title: "Split Editor Down",
      category: "View",
      keywords: ["split","horizontal","editor"],
      when: () => !!controllerContext.activeKey,
      run: () => {
        controllerContext.splitEditor("horizontal");
        return true;
      },
    },
    "workspace.goToNextSplit": {
      id: "workspace.goToNextSplit",
      title: "Go to Next Split",
      category: "View",
      keywords: ["next","splitter","navigate"],
      run: () => controllerContext.goToAdjacentSplit(1),
    },
    "workspace.goToPreviousSplit": {
      id: "workspace.goToPreviousSplit",
      title: "Go to Previous Split",
      category: "View",
      keywords: ["previous","splitter","navigate"],
      run: () => controllerContext.goToAdjacentSplit(-1),
    },
    "workspace.moveTabToNextSplit": {
      id: "workspace.moveTabToNextSplit",
      title: "Move Tab to Next Split",
      category: "View",
      keywords: ["move","tab","next","split"],
      when: () => !!controllerContext.activeKey,
      run: () => controllerContext.moveActiveTabToAdjacentSplit(1),
    },
    "workspace.moveTabToPreviousSplit": {
      id: "workspace.moveTabToPreviousSplit",
      title: "Move Tab to Previous Split",
      category: "View",
      keywords: ["move","tab","previous","split"],
      when: () => !!controllerContext.activeKey,
      run: () => controllerContext.moveActiveTabToAdjacentSplit(-1),
    },
    "workspace.equalizeSplitProportions": {
      id: "workspace.equalizeSplitProportions",
      title: "Equalize Split Proportions",
      category: "View",
      keywords: ["equalize","proportions","ratios","split"],
      when: () => !!controllerContext.splitOrientation,
      run: controllerContext.equalizeActiveSplitRatios,
    },
    "workspace.stretchActiveSplit": {
      id: "workspace.stretchActiveSplit",
      title: "Stretch Active Split",
      category: "View",
      keywords: ["stretch","widen","grow","split"],
      when: () => !!controllerContext.splitOrientation,
      run: controllerContext.stretchActiveSplit,
    },
    "workspace.unsplitAll": {
      id: "workspace.unsplitAll",
      title: "Unsplit All",
      category: "View",
      keywords: ["unsplit","close splits","single editor"],
      when: () => !!controllerContext.splitOrientation,
      run: controllerContext.unsplitAllWindows,
    }
  };
}
