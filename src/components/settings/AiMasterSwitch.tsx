import { SettingsSwitch } from "../ui/SettingsSwitch";
import { useAiStore } from "../../stores/aiStore";
import { Power } from "lucide-react";
import { useT } from "../../lib/i18n";

/**
 * Top-level toggle that disables every AI surface (drawer button, voice
 * mic button, ?? interceptor, status segments). When on, the app behaves
 * exactly like a plain terminal — zero network calls, zero models loaded.
 *
 * This is the "panic" off-switch the security-conscious user wants. It is
 * separate from the [[full-local-mode]] toggle, which keeps AI on but
 * forces all calls to loopback.
 */
export function AiMasterSwitch() {
  const { config, saving, saveConfig } = useAiStore();
  const t = useT();
  if (!config) return null;

  const disabled = !!config.fully_disabled;

  const toggle = async () => {
    await saveConfig({ ...config, fully_disabled: !disabled });
  };

  return (
    <SettingsSwitch
      data-testid="ai-master-switch"
      label={t("aiSettings.disableAi")}
      description={t(disabled ? "aiSettings.disabledOnDesc" : "aiSettings.disabledOffDesc")}
      icon={<Power className="size-5" />}
      checked={disabled}
      saving={saving}
      tone="warning"
      onToggle={toggle}
    />
  );
}
