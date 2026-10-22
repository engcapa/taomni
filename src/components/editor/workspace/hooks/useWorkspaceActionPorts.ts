import { useRef } from "react";
import { type LspPosition } from "../../../../lib/editor/lsp";
import { type OpenFileState } from "../codeWorkspaceModel";
import { type DebugBreakpoint } from "../dapDebugModel";
import { type RunPanelHandle } from "../panels/RunPanel";
import { type TerminalDockHandle } from "../panels/TerminalDockPanel";
import { type QuickDocContent } from "../referenceDocumentation";
import { useCodeDebugSession } from "../useCodeDebugSession";
import { type WorkspaceCommandContext } from "../workspaceCommands";


export function useWorkspaceActionPorts() {
  const workspaceCommandRunnerRef = useRef<(commandId: string, context?: WorkspaceCommandContext) => boolean>(() => false);
  const goToDefinitionRef = useRef<(file: OpenFileState, position: LspPosition) => Promise<boolean>>(async () => false);
  const peekDefinitionRef = useRef<(file: OpenFileState, position: LspPosition) => Promise<boolean>>(async () => false);
  const goToDeclarationRef = useRef<(file: OpenFileState, position: LspPosition) => Promise<boolean>>(async () => false);
  const goToTypeDefinitionRef = useRef<(file: OpenFileState, position: LspPosition) => Promise<boolean>>(async () => false);
  const goToImplementationRef = useRef<(file: OpenFileState, position: LspPosition) => Promise<boolean>>(async () => false);
  const renameSymbolRef = useRef<() => Promise<void>>(async () => { });
  const safeDeleteSymbolRef = useRef<() => Promise<void>>(async () => { });
  const runExtractMethodRef = useRef<() => Promise<void>>(async () => { });
  // Hover enriches the AI prompt with type information. The LSP hover callback
  // is declared further down, so read it through a ref.
  const getLspHoverRef = useRef<(
    file: OpenFileState,
    position: LspPosition,
  ) => Promise<QuickDocContent | null>>(async () => null);
  const terminalDockRef = useRef<TerminalDockHandle | null>(null);
  const runPanelRef = useRef<RunPanelHandle | null>(null);
  const runActiveJavaFileRef = useRef<() => void>(() => { });
  const buildActiveProjectRef = useRef<(rebuild?: boolean) => void>(() => { });
  const recompileActiveFileRef = useRef<() => void>(() => { });
  const toggleActiveBreakpointRef = useRef<(line: number) => void>(() => { });
  const editActiveBreakpointRef = useRef<(line: number) => void>(() => { });
  /** IDEA Ctrl+Shift+F8: popup on a caret breakpoint, else the Breakpoints dialog. */
  const viewBreakpointsAtCaretRef = useRef<(line: number) => void>(() => { });
  const openEvaluateDialogRef = useRef<(expression?: string) => void>(() => { });
  const showDebugExecutionPointRef = useRef<() => void>(() => { });
  const addActiveBreakpointRef = useRef<(line: number, options: Partial<DebugBreakpoint>) => void>(() => { });
  const toggleActiveBreakpointEnabledRef = useRef<(line: number) => void>(() => { });
  const toggleTemporaryBreakpointRef = useRef<(line: number) => void>(() => { });
  const debugRef = useRef<ReturnType<typeof useCodeDebugSession> | null>(null);
  return {
    terminalDockRef,
    workspaceCommandRunnerRef,
    getLspHoverRef,
    peekDefinitionRef,
    goToTypeDefinitionRef,
    goToImplementationRef,
    renameSymbolRef,
    safeDeleteSymbolRef,
    runExtractMethodRef,
    goToDeclarationRef,
    runActiveJavaFileRef,
    buildActiveProjectRef,
    recompileActiveFileRef,
    toggleActiveBreakpointRef,
    viewBreakpointsAtCaretRef,
    toggleTemporaryBreakpointRef,
    toggleActiveBreakpointEnabledRef,
    debugRef,
    openEvaluateDialogRef,
    showDebugExecutionPointRef,
    runPanelRef,
    goToDefinitionRef,
    editActiveBreakpointRef,
    addActiveBreakpointRef,
  };
}
