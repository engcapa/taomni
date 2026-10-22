import { type TerminalProfile } from "../../../lib/terminalProfile";
import { TerminalAppearanceSettings } from "../TerminalAppearanceSettings";
import { X } from "lucide-react";
import { useT } from "../../../lib/i18n";


export function CurrentTerminalSettingsDialog({
  profile,
  onProfileChange,
  onSaveAsDefault,
  onClose,
}: {
  profile: TerminalProfile;
  onProfileChange: (profile: TerminalProfile) => void;
  onSaveAsDefault: () => void;
  onClose: () => void;
}) {
  const t = useT();

  return (
    <div
      className="fixed inset-0 z-[900] flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("terminal.currentSettingsTitle")}
        data-testid="terminal-current-settings-dialog"
        className="max-h-[calc(100vh-32px)] w-[900px] max-w-[calc(100vw-32px)] overflow-hidden rounded-md border border-[var(--taomni-divider)] bg-[var(--taomni-bg)] shadow-xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex h-10 items-center gap-3 border-b border-[var(--taomni-divider)] px-3">
          <div className="text-[13px] font-semibold">{t("terminal.currentSettingsTitle")}</div>
          <button
            type="button"
            className="taomni-btn ml-auto h-7 w-7 p-0 inline-flex items-center justify-center"
            aria-label={t("terminal.currentSettingsClose")}
            onClick={onClose}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="max-h-[calc(100vh-112px)] overflow-auto p-3">
          <TerminalAppearanceSettings
            profile={profile}
            onProfileChange={onProfileChange}
            showCustomColors
            allowSystemTheme
          />
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-[var(--taomni-divider)] px-3 py-2">
          <button
            type="button"
            className="taomni-btn h-8 px-3"
            data-testid="terminal-current-settings-save-default"
            onClick={onSaveAsDefault}
          >
            {t("terminal.currentSettingsSaveAsDefault")}
          </button>
          <button
            type="button"
            className="taomni-btn h-8 px-3"
            data-testid="terminal-current-settings-footer-close"
            onClick={onClose}
          >
            {t("terminal.currentSettingsClose")}
          </button>
        </div>
      </div>
    </div>
  );
}
