import { useCallback,useRef,useState } from "react";
import { type LspDocumentSymbol,type LspPosition } from "../../../../lib/editor/lsp";
import { buildEditorAiPrompt,type EditorAiAction } from "../editorAiPrompts";
import { type EditorSelectionRange } from "../host/types";
import { type QuickDocContent } from "../referenceDocumentation";
import { type LspFileState,type OpenFileState } from "../codeWorkspaceModel";
import { symbolChainAtPosition } from "../Breadcrumbs";
import { createBuildEditorAiContext } from "../controller/editorMenus";


export interface UseEditorAiActionsContext {
  lspFilesRef: import("react").RefObject<Record<string,LspFileState>>;
  breadcrumbSymbolsRef: import("react").RefObject<Record<string,LspDocumentSymbol[]>>;
  activeEditorGroupIdRef: import("react").RefObject<string>;
  getLspHoverRef: import("react").RefObject<(file: OpenFileState,position: LspPosition) => Promise<QuickDocContent|null>>;
  editorAiPreferences: import("../editorAiPreferences").EditorAiPreferences;
  sendPromptToTabChat: (prompt: string) => Promise<import("../../../../stores/chatStore").EnqueueResult>;
  setStatusMessage: (message: string) => void;
  t: import("../../../../lib/i18n").TranslateFn;
  editorSelectionRef: import("react").RefObject<EditorSelectionRange>;
  activeKey: string|null;
  openFilesRef: import("react").RefObject<Record<string,import("../editorGroupTypes").OpenFileViewModel>>;
}

export function useEditorAiActions(context: UseEditorAiActionsContext) {
  const {
    lspFilesRef,
    breadcrumbSymbolsRef,
    activeEditorGroupIdRef,
    getLspHoverRef,
    editorAiPreferences,
    sendPromptToTabChat,
    setStatusMessage,
    t,
    editorSelectionRef,
    activeKey,
    openFilesRef,
  }=context;
  const [editorAiSelection,setEditorAiSelection]=useState<EditorSelectionRange|null>(null);
  const [aiRewriteState,setAiRewriteState]=useState<{
    key: string;
    path: string;
    original: string;
    proposal: string;
    instruction: string;
    range: EditorSelectionRange;
  }|null>(null);
  // Read by the dialog's Restage action, which re-asks with the edited instruction.
  const aiRewriteStateRef=useRef(aiRewriteState);
  aiRewriteStateRef.current=aiRewriteState;


  /**
   * Gather everything the AI prompt builder needs for a selection: language,
   * enclosing scope, imports, neighbouring lines, diagnostics, and LSP type
   * info. A bare selection is often only a fragment (an `impl` header, a
   * signature), so the surrounding facts are what make the answer accurate.
   */
  const buildEditorAiContext=useCallback(createBuildEditorAiContext({
    lspFilesRef,
    breadcrumbSymbolsRef,
    activeEditorGroupIdRef,
    getLspHoverRef,
  }),[]);

  /** Default rewrite/fix instruction shown in the proposal dialog. */
  const defaultAiInstruction=useCallback((action: EditorAiAction): string|undefined => (
    action==="fix"
      ? "Fix issues in the selected code"
      :action==="rewrite"
        ? "Rewrite the selected code"
        :undefined
  ),[]);

  const aiSentStatusKey=useCallback((action: EditorAiAction): string => (
    action==="explain"
      ? "codeWorkspaceAi.sentExplain"
      :action==="syntax"
        ? "codeWorkspaceAi.sentSyntax"
        :action==="fix"
          ? "codeWorkspaceAi.sentFix"
          :"codeWorkspaceAi.sentRewrite"
  ),[]);

  /**
   * Shared tail for every AI selection action: build the prompt, send it, and —
   * for the code-producing actions — open the proposal dialog so the answer can
   * be diffed against the selection before it is applied.
   */
  const dispatchEditorAiAction=useCallback(async (
    action: EditorAiAction,
    file: OpenFileState,
    selection: EditorSelectionRange,
    text: string,
  ) => {
    const instruction=defaultAiInstruction(action);
    const context=await buildEditorAiContext(action,file,selection,text,instruction);
    const prompt=buildEditorAiPrompt(context,editorAiPreferences.answerLanguage);
    await sendPromptToTabChat(prompt);

    if(action==="fix"||action==="rewrite") {
      setAiRewriteState({
        key: file.key,
        path: file.subtitle||file.path,
        original: text,
        proposal: text,
        instruction: instruction??"",
        range: selection,
      });
    }

    setEditorAiSelection(null);
    setStatusMessage(t(aiSentStatusKey(action)));
  },[
    aiSentStatusKey,
    buildEditorAiContext,
    defaultAiInstruction,
    editorAiPreferences.answerLanguage,
    sendPromptToTabChat,
    setStatusMessage,
    t,
  ]);

  /** Selection-toolbar entry point: the user has already highlighted the code. */
  const handleEditorAiAction=useCallback(async (action: EditorAiAction,text: string) => {
    const selection=editorSelectionRef.current;
    const file=activeKey? openFilesRef.current[activeKey]??null:null;
    if(!file||selection.empty||!text.trim()) return;
    await dispatchEditorAiAction(action,file,selection,text);
  },[activeKey,dispatchEditorAiAction]);

  /**
   * Command-palette / context-menu entry point, where there may be no selection.
   * Falls back to the enclosing symbol at the caret, then to the current line, so
   * "put the caret on it and ask" works without selecting anything by hand.
   */
  const runEditorAiActionAtCursor=useCallback(async (action: EditorAiAction) => {
    const file=activeKey? openFilesRef.current[activeKey]??null:null;
    if(!file) return;
    const selection=editorSelectionRef.current;
    if(!selection.empty&&selection.text.trim().length>=2) {
      await dispatchEditorAiAction(action,file,selection,selection.text);
      return;
    }

    const lines=file.text.split("\n");
    const chain=symbolChainAtPosition(
      breadcrumbSymbolsRef.current[activeEditorGroupIdRef.current]??[],
      selection.start,
    );
    const enclosing=chain[chain.length-1]?.range;
    const startLine=enclosing? enclosing.start.line:selection.start.line;
    const endLine=enclosing? enclosing.end.line:selection.start.line;
    const text=lines.slice(startLine,endLine+1).join("\n");
    if(text.trim().length<2) {
      setStatusMessage(t("codeWorkspaceAi.noSelection"));
      return;
    }

    // Synthesize the range so the prompt reports the lines it actually sent.
    const synthetic: EditorSelectionRange={
      start: { line: startLine,character: 0 },
      end: { line: endLine,character: (lines[endLine]??"").length },
      empty: false,
      text,
      rect: null,
    };
    await dispatchEditorAiAction(action,file,synthetic,text);
  },[activeKey,dispatchEditorAiAction,setStatusMessage,t]);

  /** Re-ask with the instruction the user edited in the proposal dialog. */
  const regenerateAiRewrite=useCallback(async () => {
    const state=aiRewriteStateRef.current;
    if(!state) return;
    const file=openFilesRef.current[state.key]??null;
    if(!file) return;
    const instruction=state.instruction.trim()||defaultAiInstruction("rewrite");
    const context=await buildEditorAiContext(
      "rewrite",
      file,
      state.range,
      state.original,
      instruction,
    );
    const prompt=buildEditorAiPrompt(context,editorAiPreferences.answerLanguage);
    await sendPromptToTabChat(prompt);
    setStatusMessage(t("codeWorkspaceAi.resentRewrite"));
  },[buildEditorAiContext,buildEditorAiPrompt,defaultAiInstruction,editorAiPreferences.answerLanguage,sendPromptToTabChat,setStatusMessage,t]);
  return { editorAiSelection,setEditorAiSelection,aiRewriteState,setAiRewriteState,runEditorAiActionAtCursor,handleEditorAiAction,regenerateAiRewrite };
}
