import { useEffect } from "react";
import { Radio } from "lucide-react";

import { useT } from "../../lib/i18n";
import { useLanChatStore } from "../../stores/lanChatStore";

/**
 * Global-settings section for the LAN messenger. Exposes the
 * "start on app launch" policy so it can be configured without first opening
 * (and unlocking) the chat. Shares the backend setting + store state with the
 * toggle inside LanChat's own privacy panel — both stay in sync.
 */
export function LanChatSettings() {
  const t = useT();
  const startOnLaunch = useLanChatStore((s) => s.startOnLaunch);
  const serviceRunning = useLanChatStore((s) => s.serviceRunning);
  const setStartOnLaunch = useLanChatStore((s) => s.setStartOnLaunch);
  const loadServiceState = useLanChatStore((s) => s.loadServiceState);
  const isDesktop = useLanChatStore((s) => s.isDesktop);

  useEffect(() => {
    void loadServiceState();
  }, [loadServiceState]);

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <Radio className="w-4 h-4 text-[var(--taomni-accent)]" />
        <div>
          <div className="text-[14px] font-semibold">{t("settings.lanChatSection")}</div>
          <div className="text-[11px] text-[var(--taomni-text-muted)]">
            {t("settings.lanChatSubtitle")}
          </div>
        </div>
        <span
          className="ml-auto text-[11px] font-medium"
          style={{ color: serviceRunning ? "var(--taomni-accent)" : "var(--taomni-text-muted)" }}
        >
          {serviceRunning ? `● ${t("settings.lanChatRunning")}` : `○ ${t("settings.lanChatIdle")}`}
        </span>
      </div>

      <label
        className={`flex items-start gap-3 rounded border p-3 ${
          isDesktop ? "cursor-pointer" : "opacity-60"
        } border-[var(--taomni-divider)] bg-[var(--taomni-bg)]`}
      >
        <input
          type="checkbox"
          className="mt-0.5"
          checked={startOnLaunch}
          disabled={!isDesktop}
          onChange={(e) => void setStartOnLaunch(e.target.checked)}
        />
        <div className="flex-1">
          <div className="text-[13px] font-medium">{t("settings.lanChatAutostart")}</div>
          <div className="text-[11px] text-[var(--taomni-text-muted)]">
            {t("settings.lanChatAutostartDesc")}
          </div>
        </div>
      </label>
    </div>
  );
}
