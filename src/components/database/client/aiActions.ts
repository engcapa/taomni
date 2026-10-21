import { type DbQueryResult, type DbSqlHistoryEntry } from "../../../lib/ipc";
import { useChatStore } from "../../../stores/chatStore";
import { type AiAnswerLanguage } from "../../../lib/ai/answerLanguage";
import { buildDbAiPrompt, truncateStatement } from "../../../lib/database/dbAiPrompts";
import { type EditorStatementAction } from "./types";


export interface CreateDatabaseAiActionsContext {
  tabId: string;
  setStatusMessage: (message: string) => void;
  t: import("../../../lib/i18n").TranslateFn;
  latestResultForSql: (sql: string) => DbQueryResult | null;
  aiAnswerLanguage: AiAnswerLanguage;
  setHistoryPanelId: import("react").Dispatch<import("react").SetStateAction<string | null>>;
  info: import("../../../types").DbConnectInfo;
  activeSchema: string | null;
  setStatementAction: import("react").Dispatch<import("react").SetStateAction<EditorStatementAction | null>>;
}

export function createDatabaseAiActions(context: CreateDatabaseAiActionsContext) {
  const { tabId, setStatusMessage, t, latestResultForSql, aiAnswerLanguage, setHistoryPanelId, info, activeSchema, setStatementAction } = context;

  /** Row/column shape of an in-memory result, for the prompt's context block. */
  const resultShape = (result: DbQueryResult | null): string | null => (
    result ? `${result.rows.length} row(s), ${result.columns.length} column(s)` : null
  );

  /**
   * Hand a built prompt to the tab's chat thread and report what happened. The
   * queue can refuse when it is full, and silently dropping the prompt would
   * look like the button did nothing.
   */
  const sendDbAiPrompt = async (prompt: string) => {
    await useChatStore.getState().openTabChat(tabId);
    // A complete prompt, not a quoted selection — attachToComposer's blockquote
    // prefix would fold the instructions and the SQL fence together.
    const outcome = await useChatStore.getState().sendPromptToTabChat(prompt);
    if (outcome.status === "rejected") {
      setStatusMessage(t("dbAi.queueFull", { limit: outcome.limit }));
    } else if (outcome.status === "queued") {
      setStatusMessage(t("dbAi.queued", { position: outcome.position }));
    } else {
      setStatusMessage(t("dbAi.sent"));
    }
  };

  const askAiAboutHistory = async (entry: DbSqlHistoryEntry) => {
    const { text, truncated } = truncateStatement(entry.sqlContent);
    const prompt = buildDbAiPrompt(
      {
        action: "explain",
        dialect: "sql",
        engine: entry.engine,
        statement: text,
        truncated,
        database: entry.databaseName,
        schema: entry.schemaName,
        durationMs: entry.durationMs,
        rowCount: entry.rowCount,
        error: entry.error,
        resultSummary: resultShape(latestResultForSql(entry.sqlContent)),
      },
      aiAnswerLanguage,
    );
    await sendDbAiPrompt(prompt);
    setHistoryPanelId(null);
  };

  const askAiAboutStatement = async (action: EditorStatementAction) => {
    const { text, truncated } = truncateStatement(action.range.sql);
    const prompt = buildDbAiPrompt(
      {
        action: "explain",
        dialect: "sql",
        engine: info.engine,
        statement: text,
        truncated,
        database: info.database,
        schema: activeSchema,
        resultSummary: resultShape(latestResultForSql(action.range.sql)),
      },
      aiAnswerLanguage,
    );
    await sendDbAiPrompt(prompt);
    setStatementAction(null);
  };
  return { askAiAboutStatement, askAiAboutHistory };
}
