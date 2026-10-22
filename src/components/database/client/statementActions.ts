import { type DbQueryResult, type DbSavedQuery, type DbSqlHistoryEntry } from "../../../lib/ipc";
import { type SqlEditorHandle, type SqlEditorRunContext } from "../SqlEditorPanel";
import { alertAppDialog } from "../../../lib/appDialogs";
import { explainSqlFor } from "../../../lib/sqlExplain";
import { splitSqlStatementRanges } from "../../../lib/sqlStatements";
import { writeText } from "../../../lib/clipboard";
import { type PanelState, type EditorStatementAction, type SqlStatementSourceRef } from "./types";
import { resultToJsonText } from "./queryModel";


export interface CreateStatementActionsContext {
  activePanel: PanelState;
  panels: PanelState[];
  editorHandles: import("react").RefObject<Record<string, SqlEditorHandle | null>>;
  info: import("../../../types").DbConnectInfo;
  setStatusMessage: (message: string) => void;
  runQuery: (panelId: string, sqlText: string, options?: { context?: SqlEditorRunContext; origin?: SqlStatementSourceRef["origin"]; historyId?: string; parentSheetId?: string; sheetTitle?: string; }) => Promise<void>;
  statementAction: EditorStatementAction | null;
  setStatementAction: import("react").Dispatch<import("react").SetStateAction<EditorStatementAction | null>>;
  setHistoryPanelId: import("react").Dispatch<import("react").SetStateAction<string | null>>;
  setActivePanelId: import("react").Dispatch<import("react").SetStateAction<string>>;
  openSqlInNewPanel: (sql: string, run?: boolean, origin?: SqlStatementSourceRef["origin"], savedQuery?: DbSavedQuery | null) => void;
  panelsRef: import("react").RefObject<PanelState[]>;
}

export function createStatementActions(context: CreateStatementActionsContext) {
  const {
    activePanel,
    panels,
    editorHandles,
    info,
    setStatusMessage,
    runQuery,
    statementAction,
    setStatementAction,
    setHistoryPanelId,
    setActivePanelId,
    openSqlInNewPanel,
    panelsRef,
  } = context;

  const currentEditorStatement = (panelId: string = activePanel.id): EditorStatementAction | null => {
    const panel = panels.find((p) => p.id === panelId) ?? activePanel;
    const handle = editorHandles.current[panel.id];
    const doc = handle?.getValue() ?? panel.doc;
    const selection = handle?.getSelectionRange() ?? null;
    const position = selection && selection.from !== selection.to
      ? selection.from
      : handle?.getCursorPosition() ?? doc.length;
    const ranges = splitSqlStatementRanges(doc, { splitGo: info.engine === "SQLServer" });
    const range =
      ranges.find((candidate) => candidate.from <= position && position <= candidate.to) ??
      (ranges.length === 1 ? ranges[0] : null);
    if (!range) {
      setStatusMessage("No SQL statement at the current cursor.");
      return null;
    }
    return { panelId: panel.id, doc, range };
  };

  const explainCurrentStatement = async (panelId: string = activePanel.id) => {
    const action = currentEditorStatement(panelId);
    if (!action) return;
    const plan = explainSqlFor(info.engine, action.range.sql);
    if (!plan.ok) {
      setStatusMessage(plan.reason);
      await alertAppDialog({ title: "Explain not available", message: plan.reason });
      return;
    }
    await runQuery(action.panelId, plan.sql, { sheetTitle: "Explain" });
  };

  const toggleStatementPanel = () => {
    if (statementAction?.panelId === activePanel.id) {
      setStatementAction(null);
      return;
    }
    const action = currentEditorStatement();
    if (!action) return;
    setHistoryPanelId(null);
    setStatementAction(action);
  };

  const runEditorStatement = (action: EditorStatementAction) => {
    void runQuery(action.panelId, action.range.sql, {
      context: {
        doc: action.doc,
        cursorPosition: action.range.from,
        selectionRange: { from: action.range.from, to: action.range.to },
      },
    });
    setStatementAction(null);
  };

  const runCurrentStatement = (panelId: string = activePanel.id) => {
    const action = currentEditorStatement(panelId);
    if (!action) return;
    runEditorStatement(action);
  };

  const selectEditorStatement = (action: EditorStatementAction) => {
    setActivePanelId(action.panelId);
    editorHandles.current[action.panelId]?.selectRange(action.range.from, action.range.to);
    setStatementAction(null);
  };

  const openEditorStatementInNewPanel = (action: EditorStatementAction) => {
    openSqlInNewPanel(action.range.sql, true, "editor");
    setStatementAction(null);
  };

  const latestResultForSql = (sql: string): DbQueryResult | null => {
    const target = sql.trim();
    for (const panel of [...panelsRef.current].reverse()) {
      for (const sheet of [...panel.sheets].reverse()) {
        if (sheet.sql.trim() === target && sheet.result && sheet.result.columns.length > 0) {
          return sheet.result;
        }
      }
    }
    return null;
  };

  const copyHistoryJson = async (entry: DbSqlHistoryEntry) => {
    const result = latestResultForSql(entry.sqlContent);
    if (!result) {
      setStatusMessage("No in-memory result is available for this SQL. Run it again to export JSON.");
      return;
    }
    try {
      await writeText(resultToJsonText(result));
      setStatusMessage("Copied query result JSON.");
    } catch (err) {
      setStatusMessage(`Copy JSON failed: ${String(err)}`);
    }
  };

  const copyStatementJson = async (action: EditorStatementAction) => {
    const result = latestResultForSql(action.range.sql);
    if (!result) {
      setStatusMessage("No in-memory result is available for this statement. Run it again to export JSON.");
      return;
    }
    try {
      await writeText(resultToJsonText(result));
      setStatusMessage("Copied statement result JSON.");
    } catch (err) {
      setStatusMessage(`Copy JSON failed: ${String(err)}`);
    }
  };
  return { currentEditorStatement, runCurrentStatement, latestResultForSql, explainCurrentStatement, toggleStatementPanel, copyHistoryJson, runEditorStatement, selectEditorStatement, openEditorStatementInNewPanel, copyStatementJson };
}
