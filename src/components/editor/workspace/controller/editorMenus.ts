import { lspDocumentHighlights, type LspDocumentDescriptor, type LspDocumentSymbol, type LspPosition, type LspRange } from "../../../../lib/editor/lsp";
import { type EditorGroupId } from "../../../../stores/codeWorkspaceStore";
import { CONTEXT_LINE_RADIUS, MAX_DIAGNOSTICS, describeScopeChain, extractImports, fenceLanguageFor, languageLabelFor, surroundingLines, truncateSelection, type EditorAiAction, type EditorAiContext } from "../editorAiPrompts";
import { AI_ANSWER_LANGUAGES, answerLanguageLabelKey } from "../../../../lib/ai/answerLanguage";
import { type EditorCommandId, type EditorCommandOptions, type EditorCommandTarget, type EditorContextMenuRequest, type EditorSelectionRange } from "../CodeMirrorHost";
import { buildEditorContextMenuItems } from "../editorContextMenu";
import { fieldDeclarationAt } from "../dataBreakpointTarget";
import { EditorView } from "@codemirror/view";
import { type InlineRenameAnchor } from "../InlineRenamePopup";
import { showInlineRenameMarks, suggestInlineRenameNames, type InlineRenameRange } from "../inlineRename";
import { readRefactorOptionsMode } from "../refactorOptions";
import type { MenuItem } from "../../../ContextMenu";
import { type QuickDocContent } from "../referenceDocumentation";
import { type LspFileState, type OpenFileState } from "../codeWorkspaceModel";
import { symbolChainAtPosition } from "../Breadcrumbs";
import { type InlineRenameRequest, type InlineNameResult } from "./model";



export interface BuildEditorAiContextContext {
  lspFilesRef: import("react").RefObject<Record<string, LspFileState>>;
  breadcrumbSymbolsRef: import("react").RefObject<Record<string, LspDocumentSymbol[]>>;
  activeEditorGroupIdRef: import("react").RefObject<string>;
  getLspHoverRef: import("react").RefObject<(file: OpenFileState, position: LspPosition) => Promise<QuickDocContent | null>>;
}


export function createBuildEditorAiContext(controllerContext: BuildEditorAiContextContext): (action: EditorAiAction, file: OpenFileState, selection: EditorSelectionRange, text: string, instruction?: string) => Promise<EditorAiContext> {
  return async (
    action: EditorAiAction,
    file: OpenFileState,
    selection: EditorSelectionRange,
    text: string,
    instruction?: string,
  ): Promise<EditorAiContext> => {
    const pathLabel = file.subtitle || file.path;
    const languageId = controllerContext.lspFilesRef.current[file.key]?.status?.languageId ?? null;
    const fenceLanguage = fenceLanguageFor(languageId, file.languagePath);
    const { text: selectionText, truncated } = truncateSelection(text);
    // LSP positions are 0-based; the prompt reports 1-based lines to match the
    // gutter the user is looking at.
    const startLine = selection.start.line + 1;
    const endLine = selection.end.line + 1;

    const scopeChain = describeScopeChain(
      symbolChainAtPosition(
        controllerContext.breadcrumbSymbolsRef.current[controllerContext.activeEditorGroupIdRef.current] ?? [],
        selection.start,
      ),
    );

    const diagnostics = (controllerContext.lspFilesRef.current[file.key]?.diagnostics ?? [])
      .filter((item) => (
        item.range.end.line >= selection.start.line
        && item.range.start.line <= selection.end.line
      ))
      .slice(0, MAX_DIAGNOSTICS)
      .map((item) => {
        const where = `L${item.range.start.line + 1}`;
        const code = item.code ? ` [${item.code}]` : "";
        const source = item.source ? `${item.source}: ` : "";
        return `${where} ${source}${item.message}${code}`;
      });

    const { before, after } = surroundingLines(file.text, startLine, endLine, CONTEXT_LINE_RADIUS);

    // Hover is best-effort: a cold or unsupported server must not block the ask.
    let hover: string | null = null;
    try {
      hover = (await controllerContext.getLspHoverRef.current(file, selection.start))?.body ?? null;
    } catch {
      hover = null;
    }

    return {
      action,
      filePath: pathLabel,
      languageLabel: languageLabelFor(languageId, file.languagePath),
      fenceLanguage,
      selection: selectionText,
      selectionStartLine: startLine,
      selectionEndLine: endLine,
      scopeChain,
      imports: extractImports(file.text, fenceLanguage),
      linesBefore: before,
      linesAfter: after,
      hover,
      diagnostics,
      instruction,
      truncated,
    };
  };
}



export interface PromptInlineNameContext {
  activeEditorViewFor: (fileKey: string) => EditorView | null;
  inlineRenameRef: import("react").RefObject<InlineRenameRequest | null>;
  finishInlineRename: (request: InlineRenameRequest, result: InlineNameResult) => void;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  lspDescriptorForFile: (file: OpenFileState) => LspDocumentDescriptor | null;
  setRefactorModalOptions: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  setInlineRename: import("react").Dispatch<import("react").SetStateAction<InlineRenameRequest | null>>;
  lspFilesRef: import("react").RefObject<Record<string, LspFileState>>;
}


export function createPromptInlineName(controllerContext: PromptInlineNameContext): (input: { fileKey: string; kind: "rename" | "extract"; range: LspRange; defaultName: string; initialValue?: string; error?: string | null; }) => Promise<InlineNameResult> {
  return async (input: {
    fileKey: string;
    kind: "rename" | "extract";
    range: LspRange;
    defaultName: string;
    initialValue?: string;
    error?: string | null;
  }): Promise<InlineNameResult> => {
    const view = controllerContext.activeEditorViewFor(input.fileKey);
    if (!view) return { kind: "dialog", value: input.initialValue ?? input.defaultName };
    const doc = view.state.doc;
    const offset = (position: LspPosition) => {
      const line = doc.line(Math.min(Math.max(position.line + 1, 1), doc.lines));
      return Math.min(line.from + position.character, line.to);
    };
    const target: InlineRenameRange = { from: offset(input.range.start), to: offset(input.range.end) };
    if (target.to <= target.from) return { kind: "dialog", value: input.initialValue ?? input.defaultName };
    if (controllerContext.inlineRenameRef.current) controllerContext.finishInlineRename(controllerContext.inlineRenameRef.current, { kind: "cancel" });
    view.dispatch({ effects: EditorView.scrollIntoView(target.from, { y: "nearest" }) });
    await new Promise<void>((resolve) => { window.requestAnimationFrame(() => resolve()); });
    const coords = view.coordsAtPos(target.from);
    if (!coords) return { kind: "dialog", value: input.initialValue ?? input.defaultName };
    const style = window.getComputedStyle(view.contentDOM);
    const anchor: InlineRenameAnchor = {
      left: coords.left,
      top: coords.top,
      height: Math.max(12, coords.bottom - coords.top),
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
    };
    showInlineRenameMarks(view, { target, occurrences: [] });
    const live = controllerContext.openFilesRef.current[input.fileKey];
    const descriptor = live ? controllerContext.lspDescriptorForFile(live) : null;
    return new Promise<InlineNameResult>((resolve) => {
      const request: InlineRenameRequest = {
        id: Date.now(),
        kind: input.kind,
        fileKey: input.fileKey,
        view,
        anchor,
        initialValue: input.initialValue ?? input.defaultName,
        suggestions: suggestInlineRenameNames(input.defaultName),
        initialError: input.error ?? null,
        languageId: descriptor?.languageId
          ?? (/\.java$/i.test(live?.ref.path ?? "") ? "java" : null),
        resolve,
      };
      controllerContext.inlineRenameRef.current = request;
      controllerContext.setRefactorModalOptions(readRefactorOptionsMode() === "dialog");
      controllerContext.setInlineRename(request);
      // Other occurrences in this file are boxed when the provider can answer
      // document highlights; the session never waits for them.
      const caps = controllerContext.lspFilesRef.current[input.fileKey]?.status?.capabilities;
      if (input.kind === "rename" && descriptor && caps?.documentHighlight) {
        void lspDocumentHighlights(descriptor, input.range.start)
          .then((result) => {
            if (controllerContext.inlineRenameRef.current !== request) return;
            const occurrences = result.highlights
              .map((highlight) => ({ from: offset(highlight.range.start), to: offset(highlight.range.end) }))
              .filter((range) => range.to > range.from);
            showInlineRenameMarks(view, { target, occurrences });
          })
          .catch(() => {});
      }
    });
  };
}



export interface ShowEditorContextMenuContext {
  editorSelectionRef: import("react").RefObject<EditorSelectionRange>;
  lspFilesRef: import("react").RefObject<Record<string, LspFileState>>;
  activeEditorGroupIdRef: import("react").RefObject<string>;
  actionsController: import("../useWorkspaceActionsController").WorkspaceActionsController;
  executeEditorCommandFor: (target: EditorCommandTarget | undefined, commandId: EditorCommandId, options?: EditorCommandOptions) => boolean;
  debugRef: import("react").RefObject<import("../useCodeDebugSession").CodeDebugSession | null>;
  breadcrumbSymbolsRef: import("react").RefObject<Record<string, LspDocumentSymbol[]>>;
  openEditorContextMenuAt: (x: number, y: number, items: MenuItem[], menuOptions?: import("../../../ContextMenu").ContextMenuAppearance) => void;
  t: import("../../../../lib/i18n").TranslateFn;
  editorAiPreferencesRef: import("react").RefObject<import("../editorAiPreferences").EditorAiPreferences>;
}


export function createShowEditorContextMenu(controllerContext: ShowEditorContextMenuContext): (file: OpenFileState, request: EditorContextMenuRequest & { groupId?: string; }) => void {
  return (
    file: OpenFileState,
    request: EditorContextMenuRequest & { groupId?: string },
  ) => {
    // Keep selection/cursor in sync for commands that read editorSelectionRef.
    controllerContext.editorSelectionRef.current = {
      start: request.selectionStart,
      end: request.selectionEnd,
      empty: !request.hasSelection,
      text: request.selectedText,
      rect: null,
    };
    const status = controllerContext.lspFilesRef.current[file.key]?.status;

    // §8.16.3 Gate-R1: the menu is a projection of one fresh host evaluation.
    // The payload freezes the clicked leaf/file/position, so a later active-
    // group change cannot redirect execution to another split editor.
    const targetPayload = {
      groupId: request.groupId ?? controllerContext.activeEditorGroupIdRef.current,
      fileKey: file.key,
      position: request.position,
      selectionStart: request.selectionStart,
      selectionEnd: request.selectionEnd,
      hasSelection: request.hasSelection,
      clientX: request.clientX,
      clientY: request.clientY,
    };
    const invocationContext = {
      focus: "editor" as const,
      hasSelection: request.hasSelection,
    };
    const host = controllerContext.actionsController.host;
    // §8.17.3 step 1: `run` executes the FROZEN evaluation captured at menu
    // build time. Re-entering executeAction would re-derive a fresh context
    // and let a stale/disabled row resurrect itself.
    const prepareBinding = (actionId: string, payload?: unknown) => {
      const prepared = host.prepare(actionId, {
        kind: "context-menu" as const,
        context: invocationContext,
        payload: payload ?? targetPayload,
      });
      return {
        actionId,
        prepare: prepared,
        run: () => {
          void host.executePrepared(prepared);
        },
      };
    };
    // Clipboard rows execute through the pinned editor port (frozen target),
    // not the request closures, so ownership matches the enabled state.
    const portBinding = (actionId: string, commandId: EditorCommandId) => ({
      actionId,
      prepare: host.prepare(actionId, {
        kind: "context-menu" as const,
        context: invocationContext,
        payload: targetPayload,
      }),
      run: () => { controllerContext.executeEditorCommandFor(targetPayload, commandId); },
    });

    const debugSession = controllerContext.debugRef.current;
    const fieldDeclaration = debugSession?.state && debugSession.state.status !== "terminated"
      ? fieldDeclarationAt(
        controllerContext.breadcrumbSymbolsRef.current[targetPayload.groupId as EditorGroupId] ?? [],
        request.position,
      )
      : null;

    controllerContext.openEditorContextMenuAt(
      request.clientX,
      request.clientY,
      buildEditorContextMenuItems({
        capabilities: status?.capabilities ?? null,
        hasSelection: request.hasSelection,
        clientX: request.clientX,
        clientY: request.clientY,
        shortcutFor: (actionId) => host.effectiveKeybindingDisplay(actionId)[0],
        bindings: {
          "workspace.gotoDefinition": prepareBinding("workspace.gotoDefinition"),
          "workspace.gotoDeclaration": prepareBinding("workspace.gotoDeclaration"),
          "workspace.gotoTypeDefinition": prepareBinding("workspace.gotoTypeDefinition"),
          "workspace.gotoImplementation": prepareBinding("workspace.gotoImplementation"),
          "workspace.findReferences": prepareBinding("workspace.findReferences"),
          "workspace.callHierarchy": prepareBinding("workspace.callHierarchy"),
          "workspace.typeHierarchy": prepareBinding("workspace.typeHierarchy"),
          "workspace.renameSymbol": prepareBinding("workspace.renameSymbol"),
          "workspace.safeDeleteSymbol": prepareBinding("workspace.safeDeleteSymbol"),
          "workspace.quickDocumentation": prepareBinding("workspace.quickDocumentation"),
          "workspace.codeActions": prepareBinding("workspace.codeActions", {
            ...targetPayload,
            diagnostics: (controllerContext.lspFilesRef.current[file.key]?.diagnostics ?? []).filter((item) => (
              item.range.start.line === request.position.line
              || item.range.end.line === request.position.line
            )),
          }),
          "workspace.format": prepareBinding("workspace.format"),
          "workspace.editor.foldAll": prepareBinding("workspace.editor.foldAll"),
          "workspace.editor.unfoldAll": prepareBinding("workspace.editor.unfoldAll"),
          "workspace.editor.cut": portBinding("workspace.editor.cut", "cut"),
          "workspace.editor.copy": portBinding("workspace.editor.copy", "copy"),
          "workspace.editor.paste": portBinding("workspace.editor.paste", "paste"),
        },
        debug: debugSession?.state && debugSession.state.status !== "terminated" ? {
          runToCursor: prepareBinding("workspace.runToCursor", {
            ...targetPayload,
            line: request.position.line + 1,
          }),
          ...(fieldDeclaration ? {
            dataBreakpoint: prepareBinding("workspace.addDataBreakpoint", {
              name: fieldDeclaration.name,
              frameId: debugSession.state?.selectedFrameId
                ?? debugSession.state?.frames[0]?.id
                ?? undefined,
            }),
          } : {}),
        } : null,
        ai: {
          explainSyntaxLabel: controllerContext.t("codeWorkspaceAi.contextExplainSyntax"),
          explainCodeLabel: controllerContext.t("codeWorkspaceAi.contextExplainCode"),
          explainSyntax: prepareBinding("workspace.aiExplainSyntax"),
          explainCode: prepareBinding("workspace.aiExplainCode"),
          answerLanguage: {
            label: controllerContext.t("codeWorkspaceAi.answerLanguageMenu"),
            current: controllerContext.editorAiPreferencesRef.current.answerLanguage,
            options: AI_ANSWER_LANGUAGES.map((language) => ({
              value: language,
              label: controllerContext.t(answerLanguageLabelKey(language)),
              binding: prepareBinding("workspace.aiSetAnswerLanguage", { language }),
            })),
          },
        },
      }),
    );
  };
}
