import { type MouseEvent as ReactMouseEvent } from "react";
import { Play, SquareDashedMousePointer, Sparkles, Plus, X, Save, Crosshair, Pencil } from "lucide-react";
import { type SqlEditorRunContext } from "../SqlEditorPanel";
import { formatSql } from "../formatSql";
import { useContextMenu, type MenuItem } from "../../ContextMenu";
import { useT } from "../../../lib/i18n";
import { AI_ANSWER_LANGUAGES, answerLanguageLabelKey, type AiAnswerLanguage } from "../../../lib/ai/answerLanguage";
import { type PanelState, type EditorStatementAction, type SqlStatementSourceRef } from "./types";
import { createQueryPanelActions } from "./createQueryPanelActions";
import { useQueryPanelWorkspace } from "./useQueryPanelWorkspace";

export interface UseQueryPanelInteractionsContext {
  workspace: ReturnType<typeof useQueryPanelWorkspace>;
  connectionSessionId: string | null;
  workspaceSessionId: string;
  setStatusMessage: (message: string) => void;
  info: import("../../../types").DbConnectInfo;
  currentEditorStatement: (panelId?: string) => EditorStatementAction | null;
  t: ReturnType<typeof useT>;
  askAiAboutStatement: (action: EditorStatementAction) => Promise<void>;
  aiAnswerLanguage: AiAnswerLanguage;
  setAiAnswerLanguage: import("react").Dispatch<import("react").SetStateAction<AiAnswerLanguage>>;
  runQuery: (panelId: string, sqlText: string, options?: { context?: SqlEditorRunContext; origin?: SqlStatementSourceRef["origin"]; historyId?: string; parentSheetId?: string; sheetTitle?: string; }) => Promise<void>;
  runCurrentStatement: (panelId?: string) => void;
  saveQueryFile: (panel: PanelState) => Promise<void>;
}

export function useQueryPanelInteractions(context: UseQueryPanelInteractionsContext) {
  const { workspace, connectionSessionId, workspaceSessionId, setStatusMessage, info, t, aiAnswerLanguage, setAiAnswerLanguage, runQuery } = context;
  const queryTabMenu = useContextMenu();
  const { addPanel, closePanel, closeOtherPanels, closeAllPanels } = createQueryPanelActions({
    panels: workspace.panels,
    tabLimit: workspace.tabLimit,
    setPanels: workspace.setPanels,
    setActivePanelId: workspace.setActivePanelId,
    connectionSessionId,
    timersRef: workspace.timersRef,
    editorHandles: workspace.editorHandles,
    historyRef: workspace.historyRef,
    lastAutoSavedDocRef: workspace.lastAutoSavedDocRef,
    savedQueriesRef: workspace.savedQueriesRef,
    activePanelId: workspace.activePanelId,
    persistWorkspaceSnapshot: workspace.persistWorkspaceSnapshot,
    workspaceSessionId,
    setStatusMessage,
    panelsRef: workspace.panelsRef,
  });

  const panelSql = (panel: PanelState) => workspace.editorHandles.current[panel.id]?.getValue() ?? panel.doc;

  const editorRunPayload = (panel: PanelState, selectionOnly: boolean) => {
    const handle = workspace.editorHandles.current[panel.id];
    const doc = handle?.getValue() ?? panel.doc;
    const selectionRange = selectionOnly ? handle?.getSelectionRange() ?? null : null;
    const cursorPosition = handle?.getCursorPosition() ?? doc.length;
    return {
      sql: selectionRange ? doc.slice(selectionRange.from, selectionRange.to) : doc,
      context: {
        doc,
        cursorPosition,
        selectionRange,
      } satisfies SqlEditorRunContext,
    };
  };

  const formatPanel = (panel: PanelState) => {
    const handle = workspace.editorHandles.current[panel.id];
    const formatted = formatSql(handle?.getValue() ?? panel.doc, info.engine);
    if (handle) {
      handle.setValue(formatted);
    } else {
      workspace.patchPanel(panel.id, { doc: formatted, dirty: true });
    }
  };

  const openPanelMenu = (event: ReactMouseEvent, panel: PanelState) => {
    workspace.setActivePanelId(panel.id);
    const running = panel.sheets.some((sheet) => sheet.running);
    const sqlText = panelSql(panel);
    const hasEditor = !!workspace.editorHandles.current[panel.id];
    const currentStmt = context.currentEditorStatement(panel.id);
    const items: MenuItem[] = [
      {
        label: t("tabs.rename"),
        icon: <Pencil className="w-3.5 h-3.5" />,
        testId: "db-context-rename-tab",
        onClick: () => workspace.startPanelRename(panel),
      },
      { separator: true, label: "" },
      {
        label: t("dbAi.askAiExplainSyntax"),
        icon: <Sparkles className="w-3.5 h-3.5" />,
        testId: "db-context-ai-explain-syntax",
        disabled: !currentStmt,
        onClick: () => {
          if (currentStmt) void context.askAiAboutStatement(currentStmt);
        },
      },
      {
        label: t("codeWorkspaceAi.answerLanguageMenu"),
        testId: "db-context-ai-answer-language",
        children: AI_ANSWER_LANGUAGES.map((lang) => ({
          label: t(answerLanguageLabelKey(lang)),
          testId: `db-context-ai-answer-language-${lang}`,
          checked: lang === aiAnswerLanguage,
          onClick: () => setAiAnswerLanguage(lang),
        })),
      },
      { separator: true, label: "" },
      {
        label: "Run query",
        icon: <Play className="w-3 h-3" />,
        onClick: () => {
          const payload = editorRunPayload(panel, false);
          void runQuery(panel.id, payload.sql, { context: payload.context });
        },
        disabled: running || !sqlText.trim(),
      },
      {
        label: "Run selection",
        icon: <SquareDashedMousePointer className="w-3 h-3" />,
        onClick: () => {
          const payload = editorRunPayload(panel, true);
          void runQuery(panel.id, payload.sql, { context: payload.context });
        },
        disabled: running || !hasEditor,
      },
      {
        label: "Run current statement",
        icon: <Crosshair className="w-3 h-3" />,
        onClick: () => {
          workspace.setActivePanelId(panel.id);
          context.runCurrentStatement(panel.id);
        },
        disabled: running || !hasEditor,
      },
      {
        label: "Format SQL",
        icon: <Sparkles className="w-3 h-3" />,
        onClick: () => formatPanel(panel),
        disabled: !sqlText.trim(),
      },
      {
        label: "Save query tab",
        icon: <Save className="w-3 h-3" />,
        onClick: () => void context.saveQueryFile(panel),
      },
      { label: "", separator: true, onClick: () => { } },
      {
        label: "New query tab",
        icon: <Plus className="w-3 h-3" />,
        onClick: addPanel,
        disabled: workspace.panels.length >= workspace.tabLimit,
      },
      {
        label: "Close",
        icon: <X className="w-3 h-3" />,
        onClick: () => void closePanel(panel.id),
        disabled: workspace.panels.length <= 1,
      },
      {
        label: "Close others",
        icon: <X className="w-3 h-3" />,
        onClick: () => void closeOtherPanels(panel.id),
        disabled: workspace.panels.length <= 1,
      },
      {
        label: "Close all",
        icon: <X className="w-3 h-3" />,
        onClick: () => void closeAllPanels(),
      },
    ];
    queryTabMenu.show(event, items);
  };
  return { queryTabMenu, addPanel, openPanelMenu, closePanel, editorRunPayload, formatPanel };
}
