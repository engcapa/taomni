import { type TerminalProfile } from "../../../lib/terminalProfile";
import { TerminalAppearanceSettings } from "../TerminalAppearanceSettings";
import { useT } from "../../../lib/i18n";
import { Modal } from "../../ui/Modal";

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
    <Modal
      size="complex"
      title={t("terminal.currentSettingsTitle")}
      testId="terminal-current-settings-dialog"
      closeLabel={t("terminal.currentSettingsClose")}
      initialFocus='[data-testid="terminal-current-settings-footer-close"]'
      dismissOnBackdrop={false}
      onCancel={onClose}
      footer={
        <>
          <button
            type="button"
            className="taomni-btn"
            data-testid="terminal-current-settings-save-default"
            onClick={onSaveAsDefault}
          >
            {t("terminal.currentSettingsSaveAsDefault")}
          </button>
          <button
            type="button"
            className="taomni-btn"
            data-testid="terminal-current-settings-footer-close"
            onClick={onClose}
          >
            {t("terminal.currentSettingsClose")}
          </button>
        </>
      }
    >
      <TerminalAppearanceSettings
        profile={profile}
        onProfileChange={onProfileChange}
        showCustomColors
        allowSystemTheme
      />
    </Modal>
  );
}
