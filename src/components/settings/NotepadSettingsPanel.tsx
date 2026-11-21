import { RotateCcw } from "lucide-react";
import { useT } from "../../lib/i18n";
import {
  resetNotepadPreferences,
  setNotepadPreferences,
  useNotepadPreferences,
  type NotepadBackupMode,
} from "../../stores/notepadPreferences";

export function NotepadSettingsPanel() {
  const t = useT();
  const prefs = useNotepadPreferences();

  return (
    <section
      className="taomni-settings-card flex flex-col gap-4"
      data-testid="notepad-settings"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-[16px] font-semibold">{t("notepad.settings.title")}</h3>
          <p className="text-[12px] text-[var(--taomni-text-muted)]">
            {t("notepad.settings.subtitle")}
          </p>
        </div>
        <button
          type="button"
          className="taomni-btn inline-flex items-center gap-1.5"
          data-testid="notepad-settings-reset"
          onClick={() => resetNotepadPreferences()}
        >
          <RotateCcw className="w-3.5 h-3.5" />
          {t("settings.reset")}
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-[12px]">
        <label className="flex flex-col gap-1">
          <span>{t("notepad.settings.defaultEol")}</span>
          <select
            className="np-input"
            data-testid="notepad-pref-eol"
            value={prefs.defaultEol}
            onChange={(e) => setNotepadPreferences({ defaultEol: e.target.value as "LF" | "CRLF" | "CR" })}
          >
            <option value="LF">Unix (LF)</option>
            <option value="CRLF">Windows (CRLF)</option>
            <option value="CR">Macintosh (CR)</option>
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span>{t("notepad.settings.defaultEncoding")}</span>
          <select
            className="np-input"
            data-testid="notepad-pref-encoding"
            value={prefs.defaultEncoding}
            onChange={(e) => setNotepadPreferences({ defaultEncoding: e.target.value })}
          >
            <option value="UTF-8">UTF-8</option>
            <option value="UTF-8 BOM">UTF-8 BOM</option>
            <option value="UTF-16LE">UTF-16LE</option>
            <option value="GBK">GBK</option>
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span>{t("notepad.settings.backupMode")}</span>
          <select
            className="np-input"
            data-testid="notepad-pref-backup-mode"
            value={prefs.backupMode}
            onChange={(e) => setNotepadPreferences({ backupMode: e.target.value as NotepadBackupMode })}
          >
            <option value="none">{t("notepad.settings.backupNone")}</option>
            <option value="simple">{t("notepad.settings.backupSimple")}</option>
            <option value="verbose">{t("notepad.settings.backupVerbose")}</option>
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span>{t("notepad.settings.backupInterval")}</span>
          <input
            type="number"
            min={5}
            max={300}
            className="np-input"
            data-testid="notepad-pref-backup-sec"
            value={prefs.backupSec}
            onChange={(e) => setNotepadPreferences({ backupSec: Number(e.target.value) })}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span>{t("notepad.settings.untitledPattern")}</span>
          <input
            type="text"
            className="np-input"
            data-testid="notepad-pref-untitled"
            value={prefs.untitledPattern}
            onChange={(e) => setNotepadPreferences({ untitledPattern: e.target.value })}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span>{t("notepad.settings.rulerCol")}</span>
          <input
            type="number"
            min={20}
            max={400}
            className="np-input"
            data-testid="notepad-pref-ruler-col"
            value={prefs.rulerCol}
            onChange={(e) => setNotepadPreferences({ rulerCol: Number(e.target.value) })}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span>{t("notepad.settings.recentMax")}</span>
          <input
            type="number"
            min={5}
            max={200}
            className="np-input"
            data-testid="notepad-pref-recent-max"
            value={prefs.recentMax}
            onChange={(e) => setNotepadPreferences({ recentMax: Number(e.target.value) })}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span>{t("notepad.settings.backupDir")}</span>
          <input
            type="text"
            className="np-input"
            data-testid="notepad-pref-backup-dir"
            placeholder="appData/notepad/save-backups"
            value={prefs.backupDir}
            onChange={(e) => setNotepadPreferences({ backupDir: e.target.value })}
          />
        </label>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-[12px]">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={prefs.restoreSessionOnStartup}
            data-testid="notepad-pref-restore-session"
            onChange={(e) => setNotepadPreferences({ restoreSessionOnStartup: e.target.checked })}
          />
          <span>{t("notepad.settings.restoreSession")}</span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={prefs.showLineNumbers}
            data-testid="notepad-pref-line-numbers"
            onChange={(e) => setNotepadPreferences({ showLineNumbers: e.target.checked })}
          />
          <span>{t("notepad.settings.showLineNumbers")}</span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={prefs.showRuler}
            data-testid="notepad-pref-show-ruler"
            onChange={(e) => setNotepadPreferences({ showRuler: e.target.checked })}
          />
          <span>{t("notepad.settings.showRuler")}</span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={prefs.showChangeHistory}
            data-testid="notepad-pref-change-history"
            onChange={(e) => setNotepadPreferences({ showChangeHistory: e.target.checked })}
          />
          <span>{t("notepad.settings.showChangeHistory")}</span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={prefs.askWholeDocLineOp}
            onChange={(e) => setNotepadPreferences({ askWholeDocLineOp: e.target.checked })}
          />
          <span>{t("notepad.settings.askWholeDoc")}</span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={prefs.autoReloadCleanExternal}
            onChange={(e) => setNotepadPreferences({ autoReloadCleanExternal: e.target.checked })}
          />
          <span>{t("notepad.settings.autoReloadClean")}</span>
        </label>
      </div>
    </section>
  );
}
