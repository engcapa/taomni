import { useEffect, useState } from "react";
import { Database, RotateCcw } from "lucide-react";
import { useT } from "../../lib/i18n";
import {
  DEFAULT_SQL_COMPLETION_PREFERENCES,
  displaySqlShortcut,
  loadSqlCompletionPreferences,
  normalizeSqlCompletionPreferences,
  saveSqlCompletionPreferences,
  sqlShortcutFromKeyboardEvent,
  sqlShortcutValidationError,
  subscribeSqlCompletionPreferences,
  type SqlCompletionPreferences,
  type SqlShortcutValidationError,
} from "../../lib/sqlCompletionPreferences";

function shortcutErrorKey(error: SqlShortcutValidationError): string {
  if (error === "required") return "settings.sqlCompletionShortcutRequired";
  if (error === "reserved") return "settings.sqlCompletionShortcutReserved";
  return "settings.sqlCompletionShortcutInvalid";
}

export function SqlCompletionSettings() {
  const t = useT();
  const [preferences, setPreferences] = useState(loadSqlCompletionPreferences);
  const [shortcutError, setShortcutError] = useState<SqlShortcutValidationError | null>(null);

  useEffect(
    () => subscribeSqlCompletionPreferences(setPreferences),
    [],
  );

  const updatePreferences = (patch: Partial<SqlCompletionPreferences>) => {
    const next = normalizeSqlCompletionPreferences({ ...preferences, ...patch });
    setPreferences(next);
    saveSqlCompletionPreferences(next);
  };

  const recordShortcut = (event: React.KeyboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      event.currentTarget.blur();
      setShortcutError(null);
      return;
    }
    const shortcut = sqlShortcutFromKeyboardEvent(event.nativeEvent);
    if (!shortcut) {
      if (!["Control", "Meta", "Alt", "Shift", "AltGraph"].includes(event.key)) {
        setShortcutError("invalid");
      }
      return;
    }
    const validationError = sqlShortcutValidationError(shortcut);
    setShortcutError(validationError);
    if (!validationError) updatePreferences({ triggerShortcut: shortcut });
  };

  const tabIsOnlyAcceptKey = preferences.acceptWithTab && !preferences.acceptWithEnter;
  const enterIsOnlyAcceptKey = preferences.acceptWithEnter && !preferences.acceptWithTab;

  return (
    <section
      data-testid="sql-completion-settings"
      className="mb-5 rounded-md border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] p-3"
    >
      <div className="mb-3 flex items-center gap-3">
        <Database className="h-4 w-4 text-[var(--taomni-accent)]" />
        <div>
          <div className="text-[14px] font-semibold">{t("settings.sqlCompletionTitle")}</div>
          <div className="text-[12px] text-[var(--taomni-text-muted)]">
            {t("settings.sqlCompletionSubtitle")}
          </div>
        </div>
        <button
          type="button"
          data-testid="sql-completion-reset"
          className="taomni-btn ml-auto h-7 px-2.5 inline-flex items-center gap-1 text-[11px]"
          onClick={() => {
            setShortcutError(null);
            setPreferences(DEFAULT_SQL_COMPLETION_PREFERENCES);
            saveSqlCompletionPreferences(DEFAULT_SQL_COMPLETION_PREFERENCES);
          }}
          title={t("settings.sqlCompletionResetTitle")}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          {t("settings.reset")}
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4 border-t border-[var(--taomni-divider)] pt-3 md:grid-cols-2">
        <div className="space-y-3">
          <label className="flex items-start gap-2 text-[12px]">
            <input
              data-testid="sql-completion-activate-on-typing"
              className="taomni-checkbox mt-0.5"
              type="checkbox"
              checked={preferences.activateOnTyping}
              onChange={(event) => updatePreferences({ activateOnTyping: event.target.checked })}
            />
            <span>
              <span className="block font-medium">{t("settings.sqlCompletionOnTyping")}</span>
              <span className="block text-[11px] text-[var(--taomni-text-muted)]">
                {t("settings.sqlCompletionOnTypingHint")}
              </span>
            </span>
          </label>

          <div>
            <label
              htmlFor="sql-completion-trigger-shortcut"
              className="mb-1 block text-[12px] font-medium"
            >
              {t("settings.sqlCompletionTriggerShortcut")}
            </label>
            <input
              id="sql-completion-trigger-shortcut"
              data-testid="sql-completion-trigger-shortcut"
              className="taomni-input h-8 w-full max-w-56 font-mono text-[12px]"
              value={displaySqlShortcut(preferences.triggerShortcut)}
              readOnly
              aria-invalid={shortcutError ? "true" : undefined}
              aria-describedby="sql-completion-shortcut-hint"
              onFocus={(event) => event.currentTarget.select()}
              onKeyDown={recordShortcut}
            />
            <p
              id="sql-completion-shortcut-hint"
              className={`mt-1 text-[11px] ${shortcutError ? "" : "text-[var(--taomni-text-muted)]"}`}
              style={shortcutError ? { color: "var(--taomni-warning, #b45309)" } : undefined}
              data-testid={shortcutError ? "sql-completion-shortcut-error" : undefined}
            >
              {shortcutError
                ? t(shortcutErrorKey(shortcutError))
                : t("settings.sqlCompletionShortcutHint")}
            </p>
          </div>
        </div>

        <div>
          <div className="mb-2 text-[12px] font-medium">{t("settings.sqlCompletionAcceptHeading")}</div>
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-[12px]">
              <input
                data-testid="sql-completion-accept-tab"
                className="taomni-checkbox"
                type="checkbox"
                checked={preferences.acceptWithTab}
                disabled={tabIsOnlyAcceptKey}
                onChange={(event) => updatePreferences({ acceptWithTab: event.target.checked })}
              />
              <span>{t("settings.sqlCompletionAcceptTab")}</span>
            </label>
            <label className="flex items-center gap-2 text-[12px]">
              <input
                data-testid="sql-completion-accept-enter"
                className="taomni-checkbox"
                type="checkbox"
                checked={preferences.acceptWithEnter}
                disabled={enterIsOnlyAcceptKey}
                onChange={(event) => updatePreferences({ acceptWithEnter: event.target.checked })}
              />
              <span>{t("settings.sqlCompletionAcceptEnter")}</span>
            </label>
          </div>
          <p className="mt-2 text-[11px] text-[var(--taomni-text-muted)]">
            {t("settings.sqlCompletionCursorHint", {
              shortcut: displaySqlShortcut(preferences.triggerShortcut),
            })}
          </p>
        </div>
      </div>
    </section>
  );
}
