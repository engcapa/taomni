import { type WorkspaceCommand } from "../workspaceCommands";
import { isDeclarationDefinitionEquivalentLanguage } from "../controller/model";
import { type WorkspaceCommandsContext } from "./types";


export type NavigationCommandsContext=Pick<WorkspaceCommandsContext,"openSearchEverywhere"|"seSymbolsAvailable"|"recentFilesOpen"|"openRecentFiles"|"recentChangedOnly"|"setRecentLocationsChangedOnly"|"setRecentLocationsOpen"|"navigateLastEditLocation"|"activeFile"|"navigateDiagnostic"|"editorSelectionRef"|"peekDefinitionRef"|"navCan"|"navigateHistory"|"openStructurePopup"|"resolveEditorTarget"|"lspFilesRef"|"goToTypeDefinitionRef"|"goToImplementationRef"|"activeCapabilities"|"openHierarchy"|"goToDeclarationRef"|"goToDefinition"|"activeKey"|"findReferencesRef"|"usageSessionRef"|"setLocationPeek"|"setStatusMessage"|"activateNavigationBar"|"highlightUsagesInFile"|"occurrenceSessionRef"|"navigateOccurrence"|"clearHighlightUsages"|"revealEditorTabInTree">;

export function createNavigationCommands(controllerContext: NavigationCommandsContext): Record<string,WorkspaceCommand> {
  return {
    "workspace.goToFile": {
      id: "workspace.goToFile",
      title: "Go to File",
      category: "Navigation",
      keybinding: "Ctrl+Shift+N",
      keybindings: ["Meta+Shift+N"],
      keywords: ["search everywhere","file","open"],
      run: () => controllerContext.openSearchEverywhere("files"),
    },
    "workspace.goToClass": {
      id: "workspace.goToClass",
      title: "Go to Class",
      category: "Navigation",
      keybinding: "Ctrl+N",
      keywords: ["type","interface","struct"],
      run: () => controllerContext.openSearchEverywhere(controllerContext.seSymbolsAvailable? "classes":"files"),
    },
    "workspace.goToSymbol": {
      id: "workspace.goToSymbol",
      title: "Go to Symbol",
      category: "Navigation",
      keybinding: "Ctrl+Alt+Shift+N",
      keywords: ["workspace symbol"],
      run: () => controllerContext.openSearchEverywhere(controllerContext.seSymbolsAvailable? "symbols":"files"),
    },
    "workspace.searchEverywhere": {
      id: "workspace.searchEverywhere",
      title: "Search Everywhere",
      category: "Navigation",
      keywords: ["double shift","all"],
      run: () => controllerContext.openSearchEverywhere("all"),
    },
    "workspace.recentFiles": {
      id: "workspace.recentFiles",
      title: "Recent Files",
      category: "Navigation",
      keybinding: "Ctrl+E",
      keywords: ["previous","history"],
      // ED-PARITY-014 DEC-014-03: IDEA toggles "Show edited only" on a
      // repeated Ctrl+E instead of stepping the selection.
      run: () => {
        if(controllerContext.recentFilesOpen) controllerContext.openRecentFiles({ changedOnly: !controllerContext.recentChangedOnly });
        else controllerContext.openRecentFiles();
      },
    },
    "workspace.recentLocations": {
      id: "workspace.recentLocations",
      title: "Recent Locations",
      category: "Navigation",
      keybinding: "Ctrl+Shift+E",
      keywords: ["recent","locations","snippet","preview","history"],
      run: () => {
        controllerContext.setRecentLocationsChangedOnly(false);
        controllerContext.setRecentLocationsOpen(true);
      },
    },
    "workspace.recentChangedFiles": {
      id: "workspace.recentChangedFiles",
      title: "Recently Changed Files",
      category: "Navigation",
      keywords: ["modified","changes","history"],
      run: () => {
        controllerContext.setRecentLocationsChangedOnly(true);
        controllerContext.setRecentLocationsOpen(true);
      },
    },
    "workspace.lastEditLocation": {
      id: "workspace.lastEditLocation",
      title: "Last Edit Location",
      category: "Navigation",
      keybinding: "Ctrl+Shift+Backspace",
      keywords: ["edit","history","previous","back"],
      run: () => {
        controllerContext.navigateLastEditLocation();
      },
    },
    "workspace.nextError": {
      id: "workspace.nextError",
      title: "Next Highlighted Error / Warning",
      category: "Navigation",
      keybinding: "F2",
      keywords: ["error","warning","diagnostic","problem","next"],
      when: (context) => context.focus!=="tree"&&!!controllerContext.activeFile,
      run: () => controllerContext.navigateDiagnostic(1),
    },
    "workspace.prevError": {
      id: "workspace.prevError",
      title: "Previous Highlighted Error / Warning",
      category: "Navigation",
      keybinding: "Shift+F2",
      keywords: ["error","warning","diagnostic","problem","previous"],
      when: (context) => context.focus!=="tree"&&!!controllerContext.activeFile,
      run: () => controllerContext.navigateDiagnostic(-1),
    },
    "workspace.quickDefinition": {
      id: "workspace.quickDefinition",
      title: "Quick Definition",
      category: "Navigation",
      keybinding: "Ctrl+Shift+I",
      keybindings: ["Mod-Shift-I"],
      keywords: ["peek definition","implementation","quick"],
      when: () => !!controllerContext.activeFile,
      run: () => {
        const file=controllerContext.activeFile;
        if(!file) return;
        const pos=controllerContext.editorSelectionRef.current.end;
        void controllerContext.peekDefinitionRef.current(file,{ line: pos.line,character: pos.character });
      },
    },
    "workspace.navigateBack": {
      id: "workspace.navigateBack",
      title: "Navigate Back",
      category: "Navigation",
      keybinding: "Ctrl+Alt+Left",
      // Also accept Alt+Left (common IDEA keymap variant) when history is available.
      keybindings: ["Alt+Left"],
      when: () => controllerContext.navCan.back,
      run: () => controllerContext.navigateHistory(-1),
    },
    "workspace.navigateForward": {
      id: "workspace.navigateForward",
      title: "Navigate Forward",
      category: "Navigation",
      keybinding: "Ctrl+Alt+Right",
      keybindings: ["Alt+Right"],
      when: () => controllerContext.navCan.forward,
      run: () => controllerContext.navigateHistory(1),
    },
    "workspace.fileStructure": {
      id: "workspace.fileStructure",
      title: "File Structure",
      category: "Navigation",
      keybinding: "Ctrl+F12",
      keywords: ["outline","symbol"],
      when: () => !!controllerContext.activeFile,
      run: () => void controllerContext.openStructurePopup(),
    },
    "workspace.gotoTypeDefinition": {
      id: "workspace.gotoTypeDefinition",
      title: "Go to Type Definition",
      category: "Navigation",
      keybinding: "Ctrl+Shift+B",
      when: (context) => {
        const target=controllerContext.resolveEditorTarget(context);
        const capabilities=target.file
          ? controllerContext.lspFilesRef.current[target.file.key]?.status?.capabilities
          :null;
        return context.focus!=="tree"&&!!target.file&&!target.file.loading
          &&(!capabilities||!!capabilities.typeDefinition);
      },
      run: (context) => {
        const target=controllerContext.resolveEditorTarget(context);
        if(!target.file||target.position===undefined) return;
        void controllerContext.goToTypeDefinitionRef.current(target.file,target.position);
      },
    },
    "workspace.gotoImplementation": {
      id: "workspace.gotoImplementation",
      title: "Go to Implementation",
      category: "Navigation",
      keybinding: "Ctrl+Alt+B",
      when: (context) => {
        const target=controllerContext.resolveEditorTarget(context);
        const capabilities=target.file
          ? controllerContext.lspFilesRef.current[target.file.key]?.status?.capabilities
          :null;
        return context.focus!=="tree"&&!!target.file&&!target.file.loading
          &&(!capabilities||!!capabilities.implementation);
      },
      run: (context) => {
        const target=controllerContext.resolveEditorTarget(context);
        if(!target.file||target.position===undefined) return;
        void controllerContext.goToImplementationRef.current(target.file,target.position);
      },
    },
    "workspace.callHierarchy": {
      id: "workspace.callHierarchy",
      title: "Call Hierarchy",
      category: "Navigation",
      keybinding: "Ctrl+Alt+H",
      keywords: ["callers","callees","calls"],
      when: (context) => context.focus==="editor"&&!!controllerContext.activeFile
        &&!!controllerContext.activeCapabilities?.callHierarchy,
      run: () => void controllerContext.openHierarchy("call"),
    },
    "workspace.typeHierarchy": {
      id: "workspace.typeHierarchy",
      title: "Type Hierarchy",
      category: "Navigation",
      keybinding: "Ctrl+H",
      keywords: ["supertypes","subtypes","inheritance"],
      when: (context) => context.focus==="editor"&&!!controllerContext.activeFile
        &&!!controllerContext.activeCapabilities?.typeHierarchy,
      run: () => void controllerContext.openHierarchy("type"),
    },
    "workspace.gotoDeclaration": {
      id: "workspace.gotoDeclaration",
      title: "Go to Declaration",
      category: "Navigation",
      keybinding: "Ctrl+B",
      keybindings: ["Meta+B"],
      keywords: ["declaration","jump","navigate"],
      // ED-PARITY-013: Ctrl+B is the navigation key now, so a blocked press
      // must name the real reason (loading / provider not ready) instead of
      // the generic "No selection" fallback.
      getState: (context) => {
        const target=controllerContext.resolveEditorTarget(context);
        const state=(availability: "available"|"disabled",disabledReason?: string) => ({
          availability,
          ...(disabledReason? { disabledReason }:{}),
          source: "provider" as const,
          scope: "editor" as const,
          freshness: "current" as const,
          completeness: "complete" as const,
        });
        if(context.focus==="tree"||!target.file) return state("disabled","noEditor");
        if(target.file.loading) return state("disabled","loading");
        const status=controllerContext.lspFilesRef.current[target.file.key]?.status;
        const capabilities=status?.capabilities;
        const languageId=status?.languageId??target.file.languagePath;
        const isEquivalent=isDeclarationDefinitionEquivalentLanguage(languageId,target.file.path);
        const supported=!capabilities||(isEquivalent
          ? capabilities.definition!==false
          :(capabilities.declaration!==false||capabilities.definition!==false));
        if(supported) return state("available");
        return state("disabled",status?.active? "unsupported":"providerOffline");
      },
      run: (context) => {
        const target=controllerContext.resolveEditorTarget(context);
        if(!target.file||target.position===undefined) return;
        void controllerContext.goToDeclarationRef.current(target.file,target.position);
      },
    },
    "workspace.gotoDefinition": {
      id: "workspace.gotoDefinition",
      title: "Go to Definition",
      category: "Navigation",
      // ED-PARITY-013 DEC-013-05: F12 is IDEA Jump to Last Tool Window; Ctrl+B
      // (Go to Declaration) routes to the definition where they coincide.
      keywords: ["declaration","jump","navigate"],
      when: (context) => {
        const target=controllerContext.resolveEditorTarget(context);
        const capabilities=target.file
          ? controllerContext.lspFilesRef.current[target.file.key]?.status?.capabilities
          :null;
        return context.focus==="editor"
          &&!!target.file
          &&!target.file.loading
          &&(!capabilities||!!capabilities.definition);
      },
      run: (context) => {
        const target=controllerContext.resolveEditorTarget(context);
        if(!target.file||target.position===undefined) return;
        void controllerContext.goToDefinition(target.file,target.position);
      },
    },
    "workspace.findReferences": {
      id: "workspace.findReferences",
      title: "Find Usages",
      category: "Navigation",
      keybinding: "Alt+F7",
      keywords: ["usages","references","callers"],
      when: (context) => context.focus==="editor"
        &&(!!controllerContext.activeCapabilities||!controllerContext.lspFilesRef.current[controllerContext.activeKey??""]?.status)
        &&!!controllerContext.activeFile,
      run: (context) => {
        const target=controllerContext.resolveEditorTarget(context);
        if(!target.file||target.position===undefined) return;
        void controllerContext.findReferencesRef.current(target.file,target.position);
      },
    },
    "workspace.showUsages": {
      // §8.20.5 W4: lightweight popup over the SAME immutable session as the
      // tool window. With a live session it just re-presents it; otherwise a
      // fresh scoped Find Usages runs first.
      id: "workspace.showUsages",
      title: "Show Usages",
      category: "Navigation",
      keybinding: "Ctrl+Alt+F7",
      // XWin: Ctrl+Alt+F7 switches virtual terminals on Linux.
      platformKeybindings: { linux: ["Ctrl+Alt+7"] },
      keywords: ["usages","popup","lightweight"],
      when: (context) => context.focus==="editor"&&!!controllerContext.activeFile,
      run: (context) => {
        const target=controllerContext.resolveEditorTarget(context);
        if(!target.file||target.position===undefined) return;
        const snapshot=controllerContext.usageSessionRef.current?.getCurrent();
        if(snapshot&&snapshot.state==="ready"&&snapshot.envelope.results.length>0) {
          controllerContext.setLocationPeek({
            title: `Usages of ${snapshot.symbol.displayName} (${snapshot.envelope.results.length})`,
            locations: snapshot.envelope.results.map(({ role: _role,...location }) => location),
          });
          return;
        }
        void controllerContext.findReferencesRef.current(target.file,target.position);
      },
    },
    "workspace.previousMethod": {
      id: "workspace.previousMethod",
      title: "Previous Method",
      category: "Navigation",
      keybinding: "Alt+Up",
      provenance: "unsupported",
      keywords: ["previous","method","function","navigate"],
      when: () => false,
      run: () => {
        controllerContext.setStatusMessage("Previous Method requires a language-specific syntax model (unsupported)");
      },
    },
    "workspace.nextMethod": {
      id: "workspace.nextMethod",
      title: "Next Method",
      category: "Navigation",
      keybinding: "Alt+Down",
      provenance: "unsupported",
      keywords: ["next","method","function","navigate"],
      when: () => false,
      run: () => {
        controllerContext.setStatusMessage("Next Method requires a language-specific syntax model (unsupported)");
      },
    },
    "workspace.previousSibling": {
      id: "workspace.previousSibling",
      title: "Previous Sibling",
      category: "Navigation",
      provenance: "unsupported",
      keywords: ["previous","sibling","element","navigate"],
      when: () => false,
      run: () => {
        controllerContext.setStatusMessage("Previous Sibling requires a language-specific syntax model (unsupported)");
      },
    },
    "workspace.nextSibling": {
      id: "workspace.nextSibling",
      title: "Next Sibling",
      category: "Navigation",
      provenance: "unsupported",
      keywords: ["next","sibling","element","navigate"],
      when: () => false,
      run: () => {
        controllerContext.setStatusMessage("Next Sibling requires a language-specific syntax model (unsupported)");
      },
    },
    "workspace.activateNavigationBar": {
      id: "workspace.activateNavigationBar",
      title: "Jump to Navigation Bar",
      category: "Navigate",
      keybinding: "Alt+Home",
      keywords: ["navbar","navigation","bar","breadcrumbs","jump"],
      when: (context) => context.focus==="editor"&&!!controllerContext.activeFile,
      run: controllerContext.activateNavigationBar,
    },
    "workspace.highlightUsagesInFile": {
      id: "workspace.highlightUsagesInFile",
      title: "Highlight Usages in File",
      category: "Navigate",
      keybinding: "Ctrl+Shift+F7",
      keywords: ["highlight","usages","occurrences","symbol"],
      when: (context) => context.focus==="editor"&&!!controllerContext.activeFile,
      run: controllerContext.highlightUsagesInFile,
    },
    "workspace.nextOccurrence": {
      id: "workspace.nextOccurrence",
      title: "Next Highlighted Occurrence",
      category: "Navigate",
      keybinding: "Ctrl+Alt+Down",
      keywords: ["next","occurrence","highlight"],
      when: (context) => context.focus==="editor"&&!!controllerContext.occurrenceSessionRef.current,
      run: () => controllerContext.navigateOccurrence("next"),
    },
    "workspace.previousOccurrence": {
      id: "workspace.previousOccurrence",
      title: "Previous Highlighted Occurrence",
      category: "Navigate",
      keybinding: "Ctrl+Alt+Up",
      keywords: ["previous","occurrence","highlight"],
      when: (context) => context.focus==="editor"&&!!controllerContext.occurrenceSessionRef.current,
      run: () => controllerContext.navigateOccurrence("previous"),
    },
    "workspace.clearHighlightUsages": {
      id: "workspace.clearHighlightUsages",
      title: "Clear Highlight Usages",
      category: "Navigate",
      keybinding: "Escape",
      keywords: ["clear","highlight","escape"],
      when: (context) => context.focus==="editor"&&!!controllerContext.occurrenceSessionRef.current,
      run: controllerContext.clearHighlightUsages,
    },
    "workspace.revealActiveFileInTree": {
      id: "workspace.revealActiveFileInTree",
      title: "Reveal Active File in Project Tree",
      category: "Navigation",
      keybinding: "Alt+F1",
      when: () => !!controllerContext.activeKey,
      run: () => {
        if(controllerContext.activeKey) controllerContext.revealEditorTabInTree(controllerContext.activeKey);
      },
    }
  };
}
