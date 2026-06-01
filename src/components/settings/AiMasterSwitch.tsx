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
  const { config, saveConfig } = useAiStore();
  const t = useT();
  if (!config) return null;

  const disabled = !!config.fully_disabled;

  const toggle = async () => {
    await saveConfig({ ...config, fully_disabled: !disabled });
  };

  return (
    <div
      className={`flex items-center gap-3 rounded border p-3 cursor-pointer transition-colors ${
        disabled
          ? "border-yellow-500/50 bg-yellow-500/10"
          : "border-[var(--taomni-divider)] bg-[var(--taomni-bg)]"
      }`}
      onClick={toggle}
    >
      <Power
        className={`w-5 h-5 shrink-0 ${disabled ? "text-yellow-300" : "text-[var(--taomni-text-muted)]"}`}
      />
      <div className="flex-1">
        <div className="text-[13px] font-semibold">
          {t("aiSettings.disableAi")} {disabled ? t("aiSettings.disabledSuffix") : ""}
        </div>
        <div className="text-[11px] text-[var(--taomni-text-muted)]">
          {disabled
            ? t("aiSettings.disabledOnDesc")
            : t("aiSettings.disabledOffDesc")}
        </div>
      </div>
      <div
        className={`w-9 h-5 rounded-full transition-colors relative ${
          disabled ? "bg-yellow-500" : "bg-[var(--taomni-divider)]"
        }`}
      >
        <div
          className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
            disabled ? "translate-x-4" : "translate-x-0.5"
          }`}
        />
      </div>
    </div>
  );
}
