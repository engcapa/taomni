import { useCallback, useEffect, useRef, useState } from "react";
import { type AiAnswerLanguage } from "../../../lib/ai/answerLanguage";
import { buildDbAiPrompt, truncateStatement } from "../../../lib/database/dbAiPrompts";
import { hbaseResultToGrid, writeConfirmMessage, type HBaseTransport } from "../../../lib/hbaseCommands";
import { hbaseStatementRangeAt, splitHBaseStatements } from "../../../lib/hbaseStatements";
import { useT } from "../../../lib/i18n";
import { hbaseCancel, hbaseExecute } from "../../../lib/ipc";
import { loadSqlExecutionPreferences, subscribeSqlExecutionPreferences } from "../../../lib/sqlExecutionPreferences";
import { useChatStore } from "../../../stores/chatStore";
import type { HBaseConnectInfo } from "../../../types";
import { useConfirmDialog } from "../../sidebar/ConfirmDialog";
import { type QueryRefreshMode } from "../QueryResultGrid";
import { MAX_HISTORY, newSheet } from "./model";
import { useHBaseWorkspace } from "./useHBaseWorkspace";

export interface UseHBaseExecutionContext {
  t: ReturnType<typeof useT>;
  confirmDialog: ReturnType<typeof useConfirmDialog>;
  connectionSessionId: string | null;
  workspace: ReturnType<typeof useHBaseWorkspace>;
  setRefreshSignal: import("react").Dispatch<import("react").SetStateAction<number>>;
  setStatusMessage: (message: string) => void;
  info: HBaseConnectInfo;
  transport: HBaseTransport;
  aiAnswerLanguage: AiAnswerLanguage;
  tabId: string;
}

export function useHBaseExecution(context: UseHBaseExecutionContext) {
  const { t, confirmDialog, connectionSessionId, workspace, setRefreshSignal, setStatusMessage, info, transport, aiAnswerLanguage, tabId } = context;
  const [executionPreferences, setExecutionPreferences] = useState(loadSqlExecutionPreferences);
  const historyRef = useRef<Record<string, string[]>>({});

  useEffect(
    () => subscribeSqlExecutionPreferences(setExecutionPreferences),
    [],
  );

  // EXEC_PLACEHOLDER
  // Forced confirmation before any write command (editor- or tree-initiated).
  const confirmWrite = useCallback(
    async (statement: string): Promise<boolean> => {
      const built = writeConfirmMessage(statement, {
        write: t("hbaseObjects.writeWarning"),
        destructive: t("hbaseObjects.destructiveWarning"),
      });
      if (!built) return true;
      return confirmDialog.confirm({
        title: t("hbaseObjects.confirmWriteTitle"),
        message: built.message,
        confirmLabel: t("hbaseObjects.confirmRun"),
        danger: built.danger,
      });
    },
    [confirmDialog, t],
  );

  const executeIntoSheet = useCallback(
    async (panelId: string, sheetId: string, command: string): Promise<boolean> => {
      if (!connectionSessionId) return false;
      workspace.patchSheet(panelId, sheetId, { running: true, cancelling: false, error: null, elapsedMs: 0 });
      const started = Date.now();
      const timer = window.setInterval(() => workspace.patchSheet(panelId, sheetId, { elapsedMs: Date.now() - started }), 100);
      try {
        const res = await hbaseExecute(connectionSessionId, command);
        workspace.patchSheet(panelId, sheetId, {
          result: hbaseResultToGrid(res),
          warnings: res.warnings ?? [],
          running: false,
          error: null,
          command: res.command || command,
          elapsedMs: Date.now() - started,
        });
        return true;
      } catch (err) {
        workspace.patchSheet(panelId, sheetId, {
          error: String(err),
          running: false,
          resultTab: "messages",
          elapsedMs: Date.now() - started,
        });
        return false;
      } finally {
        window.clearInterval(timer);
      }
    },
    [connectionSessionId, workspace.patchSheet],
  );

  const runStatements = useCallback(
    async (panelId: string, text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !connectionSessionId) return;
      const panel = workspace.panels.find((p) => p.id === panelId);
      if (panel?.sheets.some((s) => s.running)) return;
      const statements = splitHBaseStatements(trimmed);
      if (statements.length === 0) return;
      const h = historyRef.current[panelId] ?? [];
      if (h[0] !== trimmed) historyRef.current[panelId] = [trimmed, ...h].slice(0, MAX_HISTORY);

      let mutated = false;
      let ordinal = panel?.sheets.length ?? 0;
      for (const statement of statements) {
        const ok = await confirmWrite(statement);
        if (!ok) break;
        ordinal += 1;
        const sheet = newSheet(statement, ordinal);
        workspace.setPanels((prev) =>
          prev.map((p) =>
            p.id !== panelId ? p : { ...p, sheets: [...p.sheets, sheet].slice(-workspace.tabLimit), activeSheetId: sheet.id },
          ),
        );
        const success = await executeIntoSheet(panelId, sheet.id, statement);
        if (/^(create|drop|enable|disable|alter)\b/i.test(statement)) mutated = true;
        if (!success) break;
      }
      if (mutated) setRefreshSignal((s) => s + 1);
    },
    [connectionSessionId, workspace.panels, confirmWrite, executeIntoSheet, workspace.tabLimit],
  );

  const runCurrentStatement = useCallback(
    (panelId: string) => {
      const panel = workspace.panels.find((p) => p.id === panelId);
      if (!panel) return;
      const handle = workspace.editorHandles.current[panelId];
      const doc = handle?.getValue() ?? panel.doc;
      const selection = handle?.getSelectionRange() ?? null;
      const position = selection && selection.from !== selection.to
        ? selection.from
        : handle?.getCursorPosition() ?? doc.length;
      const range = hbaseStatementRangeAt(doc, position);
      if (!range) {
        setStatusMessage("No HBase statement at the current cursor.");
        return;
      }
      void runStatements(panelId, range.sql);
    },
    [workspace.panels, runStatements],
  );

  /**
   * Explain the statement at the cursor. Reuses the same range resolution as
   * Run, so "Explain" and "Run" always act on the statement the user believes
   * is current. Pulls in the latest result sheet for that command when there is
   * one, so a failed run gets diagnosed rather than described.
   */
  const explainCurrentStatement = useCallback(
    async (panelId: string) => {
      const panel = workspace.panels.find((p) => p.id === panelId);
      if (!panel) return;
      const handle = workspace.editorHandles.current[panelId];
      const doc = handle?.getValue() ?? panel.doc;
      const selection = handle?.getSelectionRange() ?? null;
      const position = selection && selection.from !== selection.to
        ? selection.from
        : handle?.getCursorPosition() ?? doc.length;
      const range = hbaseStatementRangeAt(doc, position);
      if (!range) {
        setStatusMessage(t("dbAi.noStatement"));
        return;
      }

      const target = range.sql.trim();
      const sheet = [...panel.sheets].reverse().find((s) => s.command.trim() === target && !s.running);
      const { text, truncated } = truncateStatement(target);
      const prompt = buildDbAiPrompt(
        {
          action: "explain",
          dialect: "hbase",
          engine: "HBase",
          statement: text,
          truncated,
          database: info.namespace,
          transport,
          durationMs: sheet?.elapsedMs ?? null,
          rowCount: sheet?.result?.rows.length ?? null,
          error: sheet?.error ?? null,
        },
        aiAnswerLanguage,
      );

      const chat = useChatStore.getState();
      await chat.openTabChat(tabId);
      const outcome = await chat.sendPromptToTabChat(prompt);
      if (outcome.status === "rejected") {
        setStatusMessage(t("dbAi.queueFull", { limit: outcome.limit }));
      } else if (outcome.status === "queued") {
        setStatusMessage(t("dbAi.queued", { position: outcome.position }));
      } else {
        setStatusMessage(t("dbAi.sent"));
      }
    },
    [aiAnswerLanguage, info.namespace, workspace.panels, setStatusMessage, t, tabId, transport],
  );

  const cancelQuery = useCallback(
    (panelId: string) => {
      workspace.setPanels((prev) =>
        prev.map((p) =>
          p.id !== panelId ? p : { ...p, sheets: p.sheets.map((s) => (s.running ? { ...s, cancelling: true } : s)) },
        ),
      );
      if (connectionSessionId) void hbaseCancel(connectionSessionId);
    },
    [connectionSessionId],
  );

  const refreshSheet = useCallback(
    (panelId: string, sheetId: string, _mode: QueryRefreshMode) => {
      const panel = workspace.panels.find((p) => p.id === panelId);
      const sheet = panel?.sheets.find((s) => s.id === sheetId);
      if (sheet) void executeIntoSheet(panelId, sheetId, sheet.command);
    },
    [workspace.panels, executeIntoSheet],
  );

  const closeResultSheets = useCallback((panelId: string, sheetIds: string[]) => {
    if (sheetIds.length === 0) return;
    const idSet = new Set(sheetIds);
    workspace.setPanels((prev) =>
      prev.map((p) => {
        if (p.id !== panelId) return p;
        const sheets = p.sheets.filter((s) => !idSet.has(s.id));
        const activeClosed = !!p.activeSheetId && idSet.has(p.activeSheetId);
        return {
          ...p,
          sheets,
          activeSheetId: activeClosed ? sheets[sheets.length - 1]?.id ?? null : p.activeSheetId,
        };
      }),
    );
  }, []);

  const closeResultSheet = useCallback(
    (panelId: string, sheetId: string) => {
      closeResultSheets(panelId, [sheetId]);
    },
    [closeResultSheets],
  );
  return {
    explainCurrentStatement,
    runStatements,
    runCurrentStatement,
    executionPreferences,
    cancelQuery,
    historyRef,
    closeResultSheet,
    closeResultSheets,
    refreshSheet,
  };
}
