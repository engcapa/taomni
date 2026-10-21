import { planReformat } from "../reformatWorkflow";
import { languageServiceReadiness } from "../languageServiceReadiness";
import { type WorkspaceCommand } from "../workspaceCommands";
import { type WorkspaceCommandsContext } from "./types";


export type CodeCommandsContext=Pick<WorkspaceCommandsContext,"requestGenerateCandidates"|"executeAutoImportOnTheFly"|"activeFile"|"lspFilesRef"|"showCodeInsightNotice"|"setParameterInfoRequestNonce"|"setIntelligenceSettingsOpen"|"optimizeImports"|"runRearrangeExecute"|"runCleanupExecute"|"editorSelectionRef"|"absolutePathForOpenFile"|"activeLanguageId"|"workspaceResourceOperationLocked"|"activeCapabilities"|"setStatusMessage"|"formatActiveFile"|"intelligencePreferences"|"setFormatOnSave"|"openQuickDocumentation"|"runTypeInfo"|"externalDocTargetFromProvider"|"runExternalDocumentation"|"runExpressionStaticData"|"openCodeActionsAtCursor">;

export function createCodeCommands(controllerContext: CodeCommandsContext): Record<string,WorkspaceCommand> {
  return {
    "editor.generateCode": {
      // §8.19.8 Generate Code: the dialog lists exactly what the provider
      // returned; without a provider this stays honestly empty.
      id: "editor.generateCode",
      title: "Generate Code…",
      category: "Code",
      keybinding: "Alt+Insert",
      keybindings: ["Meta+n"],
      keywords: ["generate","constructor","getter","setter","toString","override"],
      when: (context) => context.focus==="editor"&&!!context.hasActiveFile&&!context.readOnly,
      run: () => {
        void controllerContext.requestGenerateCandidates();
        return true;
      },
    },
    "workspace.autoImportOnTheFly": {
      id: "workspace.autoImportOnTheFly",
      title: "Auto Import on the Fly",
      category: "Code",
      keywords: ["auto import","import symbol","resolve imports"],
      when: (context) => context.focus==="editor"&&!!context.hasActiveFile&&!context.readOnly,
      run: () => {
        void controllerContext.executeAutoImportOnTheFly();
        return true;
      },
    },
    "workspace.parameterInfo": {
      id: "workspace.parameterInfo",
      title: "Parameter Info",
      category: "Code",
      keybinding: "Ctrl+P",
      keybindings: ["Mod-P"],
      keywords: ["signature","parameters","arguments"],
      when: () => !!controllerContext.activeFile,
      run: () => {
        if(!controllerContext.activeFile) return;
        // DEC-020-01: an unavailable service answers with a caret popup.
        const readiness=languageServiceReadiness(controllerContext.lspFilesRef.current[controllerContext.activeFile.key]??null);
        if(readiness.kind!=="ready"&&readiness.kind!=="idle") {
          controllerContext.showCodeInsightNotice(`Parameter info unavailable: ${readiness.message}`,readiness.action==="configure"? "configure":null);
          return;
        }
        controllerContext.setParameterInfoRequestNonce((nonce) => nonce+1);
      },
    },
    "workspace.intelligenceSettings": {
      id: "workspace.intelligenceSettings",
      title: "Editor Intelligence Settings",
      category: "Code",
      keywords: ["hover","documentation","parameter info","signature","delay"],
      run: () => controllerContext.setIntelligenceSettingsOpen(true),
    },
    "workspace.optimizeImports": {
      id: "workspace.optimizeImports",
      title: "Optimize Imports",
      category: "Code",
      keybinding: "Ctrl+Alt+O",
      keybindings: ["Mod-Alt-O"],
      keywords: ["organize imports","clean imports","sort imports"],
      when: () => !!controllerContext.activeFile,
      run: () => void controllerContext.optimizeImports(),
    },
    "workspace.rearrangeCode": {
      id: "workspace.rearrangeCode",
      title: "Rearrange Code",
      category: "Code",
      keywords: ["rearrange","members","order","declarations","structure"],
      when: () => !!controllerContext.activeFile,
      run: () => {
        if(!controllerContext.activeFile) return false;
        return controllerContext.runRearrangeExecute(controllerContext.activeFile);
      },
    },
    "workspace.codeCleanup": {
      id: "workspace.codeCleanup",
      title: "Code Cleanup...",
      category: "Code",
      keywords: ["cleanup","inspect","batch","optimize","profile"],
      when: () => !!controllerContext.activeFile,
      run: () => {
        if(!controllerContext.activeFile) return;
        return controllerContext.runCleanupExecute(controllerContext.activeFile);
      },
    },
    "workspace.format": {
      id: "workspace.format",
      title: "Format Document",
      category: "Code",
      keybinding: "Ctrl+Alt+L",
      keywords: ["format","prettier","indent","reformat"],
      when: (context) => {
        if(context.focus==="tree"||context.focus==="terminal") return false;
        // Capability readiness must not disable the command: an unreported
        // provider executes and reports its typed unavailable reason instead
        // (AC-FMT-03), and context menu + shortcut share this one action.
        return !!controllerContext.activeFile&&!controllerContext.activeFile.loading;
      },
      run: () => {
        // §8.19.9 R8-D2 / ED-STYLE-001: one typed planner resolves the
        // executable scope; everything else surfaces a typed reason.
        const selection=controllerContext.editorSelectionRef.current;
        const hasSelection=!!selection&&!selection.empty;
        const absPath=controllerContext.activeFile
          ? (controllerContext.absolutePathForOpenFile(controllerContext.activeFile)??controllerContext.activeFile.languagePath)
          :null;
        const languageKey=controllerContext.activeFile?.languagePath.split(".").pop()?.toLowerCase()??"";
        const decision=planReformat({
          scope: hasSelection? "selection":"file",
          targetPath: absPath,
          languageId: controllerContext.activeLanguageId??(languageKey||null),
          readOnly: !!controllerContext.activeFile?.library||controllerContext.workspaceResourceOperationLocked,
          hasSelection,
          capabilities: {
            formatting: !!controllerContext.activeCapabilities?.formatting,
            rangeFormatting: !!controllerContext.activeCapabilities?.rangeFormatting,
          },
        });
        if(controllerContext.activeCapabilities&&decision.kind==="unavailable") {
          controllerContext.setStatusMessage(decision.reason);
          return false;
        }
        void controllerContext.formatActiveFile();
        return true;
      },
    },
    "workspace.toggleFormatOnSave": {
      id: "workspace.toggleFormatOnSave",
      title: `${controllerContext.intelligencePreferences.formatOnSave? "Disable":"Enable"} Format on Save`,
      category: "Code",
      keywords: ["format","save","workspace"],
      run: () => controllerContext.setFormatOnSave(!controllerContext.intelligencePreferences.formatOnSave),
    },
    "workspace.quickDocumentation": {
      id: "workspace.quickDocumentation",
      title: "Quick Documentation",
      category: "Code",
      keybinding: "Ctrl+Q",
      // ED-PARITY-013: F1 is Quick Doc only in IDEA's macOS keymap; on
      // Windows/Linux IDEA reserves it for Context Help.
      platformKeybindings: { mac: ["Ctrl+Q","F1"] },
      keywords: ["docs","hover","javadoc"],
      when: (context) => context.focus!=="tree"&&context.focus!=="terminal"&&!!controllerContext.activeFile&&!controllerContext.activeFile.loading,
      run: () => void controllerContext.openQuickDocumentation(),
    },
    "workspace.typeInfo": {
      // §8.20.2 W1: IDEA 2026.2 Type Info (Ctrl+Shift+P). Honest unavailable
      // contract until a provider exposes a typed channel.
      id: "workspace.typeInfo",
      title: "Type Info",
      category: "Code",
      keybinding: "Ctrl+Shift+P",
      keybindings: ["Mod-Shift-P"],
      keywords: ["expression type","reference information"],
      when: (context) => context.focus!=="tree"&&context.focus!=="terminal"&&!!controllerContext.activeFile&&!controllerContext.activeFile.loading,
      run: () => void controllerContext.runTypeInfo(),
    },
    "workspace.externalDocumentation": {
      // §8.20.2 W1: enabled ONLY from a real provider URL in the last ready
      // quick documentation — never synthesized from the symbol name.
      id: "workspace.externalDocumentation",
      title: "External Documentation",
      category: "Code",
      keywords: ["javadoc online","browser docs","url"],
      when: (context) => context.focus!=="tree"
        &&context.focus!=="terminal"
        &&!!controllerContext.activeFile
        &&!controllerContext.activeFile.loading
        &&controllerContext.externalDocTargetFromProvider()!==null,
      run: () => void controllerContext.runExternalDocumentation(),
    },
    "workspace.expressionStaticData": {
      // §8.20.2 W1: discoverable Expression Static Data entry; reports an
      // explicit provider-unavailable instead of local text guessing.
      id: "workspace.expressionStaticData",
      title: "Expression Static Data",
      category: "Code",
      keywords: ["static data","branch","nullness","constant","reference information"],
      when: (context) => context.focus!=="tree"&&context.focus!=="terminal"&&!!controllerContext.activeFile&&!controllerContext.activeFile.loading,
      run: () => void controllerContext.runExpressionStaticData(),
    },
    "workspace.codeActions": {
      id: "workspace.codeActions",
      title: "Show Code Actions / Quick Fix",
      category: "Code",
      keybinding: "Alt+Enter",
      keywords: ["quickfix","bulb","intention"],
      when: (context) => context.focus!=="tree"&&context.focus!=="terminal"&&!!controllerContext.activeFile&&!controllerContext.activeFile.loading,
      run: (context) => controllerContext.openCodeActionsAtCursor(context),
    }
  };
}
