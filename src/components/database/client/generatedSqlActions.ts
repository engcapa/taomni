import { dbRewriteResultSql, type DbResultSqlRewriteRequest } from "../../../lib/ipc";
import { type SqlEditorHandle } from "../SqlEditorPanel";
import { type QueryGeneratedSqlSyncMode } from "../QueryResultGrid";
import { type PanelState } from "./types";
import { newPanel, hashSqlText, replacementEndWithExistingTerminator } from "./queryModel";


export interface CreateGeneratedSqlActionsContext {
  setPanels: import("react").Dispatch<import("react").SetStateAction<PanelState[]>>;
  panelsRef: import("react").RefObject<PanelState[]>;
  activePanelIdRef: import("react").RefObject<string>;
  editorHandles: import("react").RefObject<Record<string, SqlEditorHandle | null>>;
  setStatusMessage: (message: string) => void;
  setActivePanelId: import("react").Dispatch<import("react").SetStateAction<string>>;
  tabLimit: number;
  refreshSheet: (panelId: string, sheetId: string, mode: import("../QueryResultGrid").QueryRefreshMode, sqlOverride?: string) => Promise<void>;
}

export function createGeneratedSqlActions(context: CreateGeneratedSqlActionsContext) {
  const { setPanels, panelsRef, activePanelIdRef, editorHandles, setStatusMessage, setActivePanelId, tabLimit, refreshSheet } = context;

  const setPanelDocState = (panelId: string, doc: string) => {
    setPanels((prev) => {
      const next = prev.map((panel) => (panel.id === panelId ? { ...panel, doc, dirty: true } : panel));
      panelsRef.current = next;
      return next;
    });
  };

  const writePanelDocument = (panelId: string, doc: string) => {
    const editor = activePanelIdRef.current === panelId ? editorHandles.current[panelId] : null;
    editor?.setValue(doc);
    setPanelDocState(panelId, doc);
  };

  const syncGeneratedSqlPanel = (
    resultPanelId: string,
    sheetId: string,
    generatedSql: string,
    status: string | null = "Synced generated SQL to query editor.",
    options: { activate?: boolean; } = {},
  ): string | null => {
    const activate = options.activate ?? true;
    const livePanels = panelsRef.current;
    const resultPanel = livePanels.find((panel) => panel.id === resultPanelId);
    const sheet = resultPanel?.sheets.find((candidate) => candidate.id === sheetId);
    if (!resultPanel || !sheet) {
      setStatusMessage("Result sheet is no longer available.");
      return null;
    }

    const existingTargetId =
      sheet.generatedTargetPanelId && livePanels.some((panel) => panel.id === sheet.generatedTargetPanelId)
        ? sheet.generatedTargetPanelId
        : null;
    if (existingTargetId) {
      writePanelDocument(existingTargetId, generatedSql);
      if (activate) setActivePanelId(existingTargetId);
      if (status) setStatusMessage(status);
      return existingTargetId;
    }

    if (livePanels.length >= tabLimit) {
      setStatusMessage(`Maximum query panels reached (${tabLimit}).`);
      return null;
    }

    const targetPanel = newPanel({ doc: generatedSql, dirty: true, fileName: "Generated SQL" });
    setPanels((prev) => {
      const next = [
        ...prev.map((panel) =>
          panel.id === resultPanelId
            ? {
              ...panel,
              sheets: panel.sheets.map((candidate) =>
                candidate.id === sheetId
                  ? { ...candidate, generatedTargetPanelId: targetPanel.id }
                  : candidate,
              ),
            }
            : panel,
        ),
        targetPanel,
      ];
      panelsRef.current = next;
      return next;
    });
    if (activate) setActivePanelId(targetPanel.id);
    if (status) setStatusMessage(status);
    return targetPanel.id;
  };

  const replaceGeneratedSqlSource = (
    resultPanelId: string,
    sheetId: string,
    generatedSql: string,
    options: {
      activate?: boolean;
      focus?: boolean;
      status?: string | null;
      fallback?: boolean;
      updateSheetSql?: boolean;
    } = {},
  ): boolean => {
    const activate = options.activate ?? true;
    const focus = options.focus ?? true;
    const status = options.status ?? "Replaced source SQL with generated SQL.";
    const fallbackEnabled = options.fallback ?? true;
    const updateSheetSql = options.updateSheetSql ?? false;
    const fallback = () =>
      fallbackEnabled
        ? syncGeneratedSqlPanel(
          resultPanelId,
          sheetId,
          generatedSql,
          "Source SQL changed; synced generated SQL to a query editor instead.",
        )
        : null;
    const livePanels = panelsRef.current;
    const resultPanel = livePanels.find((panel) => panel.id === resultPanelId);
    const sheet = resultPanel?.sheets.find((candidate) => candidate.id === sheetId);
    const sourceRef = sheet?.sourceRef;
    if (!sheet || !sourceRef || sourceRef.origin !== "editor" || sourceRef.from === null || sourceRef.to === null) {
      fallback();
      return false;
    }

    const sourcePanel = livePanels.find((panel) => panel.id === sourceRef.panelId);
    if (!sourcePanel) {
      fallback();
      return false;
    }

    const from = sourceRef.from;
    const to = sourceRef.to;
    const editor = activePanelIdRef.current === sourcePanel.id ? editorHandles.current[sourcePanel.id] : null;
    const sourceDoc = editor?.getValue() ?? sourcePanel.doc;
    if (from < 0 || to < from || to > sourceDoc.length) {
      fallback();
      return false;
    }

    const currentSql = sourceDoc.slice(from, to);
    if (currentSql !== sourceRef.sql || hashSqlText(currentSql) !== sourceRef.exactHash) {
      fallback();
      return false;
    }

    const replaceTo = replacementEndWithExistingTerminator(sourceDoc, to, generatedSql);
    const nextDoc = `${sourceDoc.slice(0, from)}${generatedSql}${sourceDoc.slice(replaceTo)}`;
    const delta = generatedSql.length - (replaceTo - from);
    editor?.replaceRange(from, replaceTo, generatedSql, { focus });
    const nextPanels = livePanels.map((panel) => {
      const patchedPanel =
        panel.id === sourcePanel.id ? { ...panel, doc: nextDoc, dirty: true } : panel;
      const sheets = patchedPanel.sheets.map((candidate) => {
        const candidateRef = candidate.sourceRef;
        let nextRef = candidateRef;
        if (
          candidateRef &&
          candidateRef.panelId === sourcePanel.id &&
          candidateRef.from !== null &&
          candidateRef.to !== null
        ) {
          if (candidateRef.id === sourceRef.id) {
            nextRef = {
              ...candidateRef,
              sql: generatedSql,
              to: from + generatedSql.length,
              exactHash: hashSqlText(generatedSql),
              parentSheetId: sheetId,
            };
          } else if (candidateRef.from >= replaceTo) {
            nextRef = {
              ...candidateRef,
              from: candidateRef.from + delta,
              to: candidateRef.to + delta,
            };
          }
        }
        return {
          ...candidate,
          baseSql: updateSheetSql && panel.id === resultPanelId && candidate.id === sheetId
            ? generatedSql
            : candidate.baseSql,
          sql: updateSheetSql && panel.id === resultPanelId && candidate.id === sheetId
            ? generatedSql
            : candidate.sql,
          sourceRef: nextRef,
        };
      });
      return { ...patchedPanel, sheets };
    });
    panelsRef.current = nextPanels;
    setPanels(nextPanels);
    if (activate) setActivePanelId(sourcePanel.id);
    if (status) setStatusMessage(status);
    return true;
  };

  const queryGeneratedSqlFromSheet = async (
    resultPanelId: string,
    sheetId: string,
    generatedSql: string,
    rewriteRequest?: DbResultSqlRewriteRequest,
  ) => {
    let sql = generatedSql;
    if (rewriteRequest) {
      try {
        const rewritten = await dbRewriteResultSql(rewriteRequest);
        if (rewritten.mode !== "inline" || !rewritten.sql) {
          setStatusMessage(rewritten.reason ?? "SQL rewrite is not available for this result.");
          return;
        }
        sql = rewritten.sql;
      } catch (err) {
        setStatusMessage(`SQL rewrite failed: ${String(err)}`);
        return;
      }
    }

    const replaced = replaceGeneratedSqlSource(resultPanelId, sheetId, sql, {
      activate: false,
      focus: false,
      status: null,
      updateSheetSql: true,
    });
    if (!replaced) return;
    setStatusMessage("Applied result filters to SQL; refreshing result.");
    await refreshSheet(resultPanelId, sheetId, "clearView", sql);
  };

  const syncGeneratedSqlFromSheet = (
    resultPanelId: string,
    sheetId: string,
    generatedSql: string,
    mode: QueryGeneratedSqlSyncMode,
  ) => {
    if (mode === "replaceSource") {
      replaceGeneratedSqlSource(resultPanelId, sheetId, generatedSql, { updateSheetSql: true });
      return;
    }
    syncGeneratedSqlPanel(resultPanelId, sheetId, generatedSql);
  };
  return { syncGeneratedSqlFromSheet, queryGeneratedSqlFromSheet };
}
