import { useState } from "react";
import { Play, SquareDashedMousePointer, Ban, Sparkles, Clock, Save, Star, Crosshair, ListTree, Check, ChevronDown, Languages, GitCommitHorizontal, Undo2 } from "lucide-react";
import { type DbTxStatus } from "../../../lib/ipc";
import { useT } from "../../../lib/i18n";
import { AI_ANSWER_LANGUAGES, answerLanguageLabelKey, type AiAnswerLanguage } from "../../../lib/ai/answerLanguage";
import { MAX_DATABASE_TAB_LIMIT, MIN_DATABASE_TAB_LIMIT } from "../../../lib/databaseTabLimit";
import { MIN_ROW_LIMIT, MAX_ROW_LIMIT } from "./persistence";


export function EditorToolbar({
  engine,
  schemas,
  activeSchema,
  running,
  runAllTitle,
  runSelectionTitle,
  runCurrentTitle,
  aiAnswerLanguage = "inherit",
  onSetAiAnswerLanguage,
  onRun,
  onRunSelection,
  onRunCurrent,
  onExplain,
  onCancel,
  txAvailable,
  txStatus,
  onToggleTx,
  onCommitTx,
  onRollbackTx,
  onFormat,
  onToggleStatement,
  onToggleHistory,
  onSave,
  onSaveQuery,
  onSchemaChange,
  rowLimit,
  tabLimit,
  onRowLimitChange,
  onTabLimitChange,
}: {
  engine: string;
  schemas: string[];
  activeSchema: string | null;
  running: boolean;
  runAllTitle: string;
  runSelectionTitle: string;
  runCurrentTitle: string;
  aiAnswerLanguage?: AiAnswerLanguage;
  onSetAiAnswerLanguage?: (lang: AiAnswerLanguage) => void;
  onRun: () => void;
  onRunSelection: () => void;
  onRunCurrent: () => void;
  onExplain: () => void;
  onCancel: () => void;
  txAvailable: boolean;
  txStatus: DbTxStatus | null;
  onToggleTx: () => void;
  onCommitTx: () => void;
  onRollbackTx: () => void;
  onFormat: () => void;
  onToggleStatement: () => void;
  onToggleHistory: () => void;
  onSave: () => void;
  onSaveQuery: () => void;
  onSchemaChange: (schema: string) => void;
  rowLimit: number;
  tabLimit: number;
  onRowLimitChange: (value: number) => void;
  onTabLimitChange: (value: number) => void;
}) {
  const t = useT();
  const [langMenuOpen, setLangMenuOpen] = useState(false);
  const txManual = txStatus?.manual === true;
  const btn = "h-6 px-2 inline-flex items-center gap-1 rounded text-[11px] hover:bg-[var(--taomni-hover)] disabled:opacity-40";
  const input = "taomni-input h-6 w-[68px] text-[11px]";
  return (
    <div
      className="h-8 shrink-0 flex items-center gap-1 px-2"
      style={{ background: "var(--taomni-quick-bg)", borderBottom: "1px solid var(--taomni-divider)" }}
    >
      <button type="button" className={btn} onClick={onRun} disabled={running} title={runAllTitle} data-testid="db-run-all">
        <Play className="w-3.5 h-3.5" style={{ color: "#62d36f" }} /> Run
      </button>
      <button type="button" className={btn} onClick={onRunSelection} disabled={running} title={runSelectionTitle}>
        <SquareDashedMousePointer className="w-3.5 h-3.5" /> Selection
      </button>
      <button
        type="button"
        className={btn}
        onClick={onRunCurrent}
        disabled={running}
        title={runCurrentTitle}
        data-testid="db-run-current-statement"
      >
        <Crosshair className="w-3.5 h-3.5" /> Current
      </button>
      <button
        type="button"
        className={btn}
        onClick={onExplain}
        disabled={running}
        title="Explain the statement at the cursor"
        data-testid="db-explain-current"
      >
        <ListTree className="w-3.5 h-3.5" /> Explain
      </button>
      <button type="button" className={btn} onClick={onCancel} disabled={!running} title="Cancel query">
        <Ban className="w-3.5 h-3.5" style={{ color: "#d9534f" }} /> Cancel
      </button>
      {txAvailable && (
        <>
          <span className="w-px h-4 mx-1" style={{ background: "var(--taomni-divider)" }} />
          <button
            type="button"
            className={btn}
            onClick={onToggleTx}
            disabled={running || !txStatus?.supported}
            title={txManual ? "Manual commit (click for auto-commit)" : "Auto-commit (click for manual commit)"}
            data-testid="db-tx-mode"
            data-mode={txManual ? "manual" : "auto"}
            aria-pressed={txManual}
          >
            {txManual ? "Manual" : "Auto"}
          </button>
          {txManual && (
            <>
              <button type="button" className={btn} onClick={onCommitTx} disabled={running} title="Commit" data-testid="db-tx-commit">
                <GitCommitHorizontal className="w-3.5 h-3.5" /> Commit
              </button>
              <button type="button" className={btn} onClick={onRollbackTx} disabled={running} title="Rollback" data-testid="db-tx-rollback">
                <Undo2 className="w-3.5 h-3.5" /> Rollback
              </button>
              <span
                className="text-[11px] tabular-nums"
                style={{ color: txStatus && txStatus.pending > 0 ? "var(--taomni-accent)" : "var(--taomni-text-muted)" }}
                title="Statements executed since the last commit or rollback"
                data-testid="db-tx-pending"
              >
                Pending: {txStatus?.pending ?? 0}
              </span>
            </>
          )}
        </>
      )}
      <span className="w-px h-4 mx-1" style={{ background: "var(--taomni-divider)" }} />
      <button type="button" className={btn} onClick={onFormat} title="Format SQL">
        <Sparkles className="w-3.5 h-3.5" /> Format
      </button>
      <button type="button" className={btn} onClick={onToggleStatement} title="Current statement actions">
        <SquareDashedMousePointer className="w-3.5 h-3.5" /> Statement
      </button>
      <button type="button" className={btn} onClick={onToggleHistory} title="Query history" data-testid="db-query-history-toggle">
        <Clock className="w-3.5 h-3.5" /> History
      </button>
      <button type="button" className={btn} onClick={onSave} title="Save query tab as SQL file">
        <Save className="w-3.5 h-3.5" /> Save
      </button>
      <button type="button" className={btn} onClick={onSaveQuery} title="Save to query library" data-testid="db-save-query">
        <Star className="w-3.5 h-3.5 text-[var(--taomni-accent)]" /> Save Query
      </button>
      {onSetAiAnswerLanguage && (
        <div className="relative">
          <button
            type="button"
            className={btn}
            data-testid="db-ai-answer-language-toggle"
            title={t("codeWorkspaceAi.answerLanguageTooltip", { current: t(answerLanguageLabelKey(aiAnswerLanguage)) })}
            onClick={() => setLangMenuOpen((v) => !v)}
          >
            <Languages className="w-3.5 h-3.5" />
            <span>{t(answerLanguageLabelKey(aiAnswerLanguage))}</span>
            <ChevronDown className="w-3 h-3 opacity-60" />
          </button>
          {langMenuOpen && (
            <div
              className="absolute right-0 top-full mt-1 z-50 py-1 rounded shadow-lg border text-[11px] min-w-[120px]"
              style={{ background: "var(--taomni-panel-bg)", borderColor: "var(--taomni-divider)", color: "var(--taomni-text)" }}
            >
              {AI_ANSWER_LANGUAGES.map((lang) => (
                <button
                  key={lang}
                  type="button"
                  data-testid={`db-ai-answer-language-option-${lang}`}
                  className="w-full px-2 py-1 text-left flex items-center justify-between hover:bg-[var(--taomni-hover)]"
                  onClick={() => {
                    onSetAiAnswerLanguage(lang);
                    setLangMenuOpen(false);
                  }}
                >
                  <span>{t(answerLanguageLabelKey(lang))}</span>
                  {lang === aiAnswerLanguage && <Check className="w-3 h-3 text-[var(--taomni-accent)]" />}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <span className="w-px h-4 mx-1" style={{ background: "var(--taomni-divider)" }} />
      <label className="h-6 inline-flex items-center gap-1 text-[11px] text-[var(--taomni-text-muted)]">
        Rows
        <input
          className={input}
          type="number"
          min={MIN_ROW_LIMIT}
          max={MAX_ROW_LIMIT}
          value={rowLimit}
          title="Maximum rows returned by each query"
          onChange={(event) => onRowLimitChange(Number(event.target.value))}
        />
      </label>
      <label className="h-6 inline-flex items-center gap-1 text-[11px] text-[var(--taomni-text-muted)]">
        Tab limit
        <input
          data-testid="db-tab-limit"
          className={input}
          type="number"
          min={MIN_DATABASE_TAB_LIMIT}
          max={MAX_DATABASE_TAB_LIMIT}
          value={tabLimit}
          title="Maximum query tabs per session and result tabs per query"
          onChange={(event) => onTabLimitChange(Number(event.target.value))}
        />
      </label>
      <div className="flex-1" />
      {schemas.length > 0 && (
        <select
          className="taomni-input h-6 max-w-[180px] text-[11px]"
          value={activeSchema ?? ""}
          aria-label="Schema"
          title="Schema / database"
          onChange={(event) => onSchemaChange(event.target.value)}
        >
          {schemas.map((schema) => (
            <option key={schema} value={schema}>
              {schema}
            </option>
          ))}
        </select>
      )}
      <span className="text-[10px] text-[var(--taomni-text-muted)]">{engine}</span>
    </div>
  );
}
