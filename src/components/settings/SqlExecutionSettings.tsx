import { useEffect, useState } from "react";
import { Crosshair, RotateCcw } from "lucide-react";
import { useT } from "../../lib/i18n";
import {
  displaySqlShortcut,
  sqlShortcutFromKeyboardEvent,
} from "../../lib/sqlCompletionPreferences";
import {
  DEFAULT_SQL_EXECUTION_PREFERENCES,
  completionShortcutConflictingWithExecutionCandidate,
  loadSqlExecutionPreferences,
  normalizeSqlExecutionPreferences,
  saveSqlExecutionPreferences,
  sqlExecutionConflictField,
  sqlExecutionShortcutValidationError,
  subscribeSqlExecutionPreferences,
  type SqlExecutionShortcutField,
  type SqlExecutionValidationError,
} from "../../lib/sqlExecutionPreferences";

function errorMessage(
  t: (key: string, vars?: Record<string, string | number>) => string,
  error: SqlExecutionValidationError,
  conflictField: SqlExecutionShortcutField | null,
): string {
  if (error === "required") return t("settings.sqlExecutionShortcutRequired");
  if (error === "invalid") return t("settings.sqlExecutionShortcutInvalid");
  if (error === "reserved") return t("settings.sqlExecutionShortcutReserved");
  if (error === "conflict" && conflictField) {
    const labelKey =
      conflictField === "runAll"
        ? "settings.sqlExecutionRunAll"
        : conflictField === "runSelection"
          ? "settings.sqlExecutionRunSelection"
          : "settings.sqlExecutionRunCurrent";
    return t("settings.sqlExecutionConflict", { shortcut: t(labelKey) });
  }
  return t("settings.sqlExecutionConflict", { shortcut: "another execution shortcut" });
}

const FIELDS: Array<{
  field: SqlExecutionShortcutField;
  labelKey: string;
  hintKey: string;
  testId: string;
}> = [
  {
    field: "runAll",
    labelKey: "settings.sqlExecutionRunAll",
    hintKey: "settings.sqlExecutionRunAllHint",
    testId: "sql-execution-run-all",
  },
  {
    field: "runSelection",
    labelKey: "settings.sqlExecutionRunSelection",
    hintKey: "settings.sqlExecutionRunSelectionHint",
    testId: "sql-execution-run-selection",
  },
  {
    field: "runCurrent",
    labelKey: "settings.sqlExecutionRunCurrent",
    hintKey: "settings.sqlExecutionRunCurrentHint",
    testId: "sql-execution-run-current",
  },
];

export function SqlExecutionSettings() {
  const t = useT();
  const [preferences, setPreferences] = useState(loadSqlExecutionPreferences);
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<SqlExecutionShortcutField, SqlExecutionValidationError>>
  >({});
  const [conflictFields, setConflictFields] = useState<
    Partial<Record<SqlExecutionShortcutField, SqlExecutionShortcutField | null>>
  >({});

  useEffect(
    () => subscribeSqlExecutionPreferences(setPreferences),
    [],
  );

  const recordShortcut = (
    field: SqlExecutionShortcutField,
    event: React.KeyboardEvent<HTMLInputElement>,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      event.currentTarget.blur();
      setFieldErrors((prev) => ({ ...prev, [field]: undefined }));
      setConflictFields((prev) => ({ ...prev, [field]: null }));
      return;
    }
    const shortcut = sqlShortcutFromKeyboardEvent(event.nativeEvent);
    if (!shortcut) {
      if (!["Control", "Meta", "Alt", "Shift", "AltGraph"].includes(event.key)) {
        setFieldErrors((prev) => ({ ...prev, [field]: "invalid" }));
        setConflictFields((prev) => ({ ...prev, [field]: null }));
      }
      return;
    }
    const validationError = sqlExecutionShortcutValidationError(shortcut);
    if (validationError) {
      setFieldErrors((prev) => ({ ...prev, [field]: validationError }));
      setConflictFields((prev) => ({ ...prev, [field]: null }));
      return;
    }
    if (completionShortcutConflictingWithExecutionCandidate(shortcut)) {
      setFieldErrors((prev) => ({ ...prev, [field]: "reserved" }));
      setConflictFields((prev) => ({ ...prev, [field]: null }));
      return;
    }
    const conflict = sqlExecutionConflictField(preferences, field, shortcut);
    if (conflict) {
      setFieldErrors((prev) => ({ ...prev, [field]: "conflict" }));
      setConflictFields((prev) => ({ ...prev, [field]: conflict }));
      return;
    }
    const next = normalizeSqlExecutionPreferences({ ...preferences, [field]: shortcut });
    setFieldErrors((prev) => ({ ...prev, [field]: undefined }));
    setConflictFields((prev) => ({ ...prev, [field]: null }));
    setPreferences(next);
    saveSqlExecutionPreferences(next);
  };

  return (
    <section
      data-testid="sql-execution-settings"
      className="mb-5 rounded-md border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] p-3"
    >
      <div className="mb-3 flex items-center gap-3">
        <Crosshair className="h-4 w-4 text-[var(--taomni-accent)]" />
        <div>
          <div className="text-[14px] font-semibold">{t("settings.sqlExecutionTitle")}</div>
          <div className="text-[12px] text-[var(--taomni-text-muted)]">
            {t("settings.sqlExecutionSubtitle")}
          </div>
        </div>
        <button
          type="button"
          data-testid="sql-execution-reset"
          className="taomni-btn ml-auto h-7 px-2.5 inline-flex items-center gap-1 text-[11px]"
          onClick={() => {
            setFieldErrors({});
            setConflictFields({});
            setPreferences(DEFAULT_SQL_EXECUTION_PREFERENCES);
            saveSqlExecutionPreferences(DEFAULT_SQL_EXECUTION_PREFERENCES);
          }}
          title={t("settings.sqlExecutionResetTitle")}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          {t("settings.reset")}
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4 border-t border-[var(--taomni-divider)] pt-3 md:grid-cols-3">
        {FIELDS.map(({ field, labelKey, hintKey, testId }) => {
          const error = fieldErrors[field];
          return (
            <div key={field}>
              <label htmlFor={testId} className="mb-1 block text-[12px] font-medium">
                {t(labelKey)}
              </label>
              <input
                id={testId}
                data-testid={testId}
                className="taomni-input h-8 w-full font-mono text-[12px]"
                value={displaySqlShortcut(preferences[field])}
                readOnly
                aria-invalid={error ? "true" : undefined}
                aria-describedby={`${testId}-hint`}
                onFocus={(event) => event.currentTarget.select()}
                onKeyDown={(event) => recordShortcut(field, event)}
              />
              <p
                id={`${testId}-hint`}
                className={`mt-1 text-[11px] ${error ? "" : "text-[var(--taomni-text-muted)]"}`}
                style={error ? { color: "var(--taomni-warning, #b45309)" } : undefined}
                data-testid={error ? `${testId}-error` : undefined}
              >
                {error
                  ? errorMessage(t, error, conflictFields[field] ?? null)
                  : t(hintKey)}
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
}
