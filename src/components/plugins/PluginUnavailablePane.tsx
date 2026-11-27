import type { ReactNode } from "react";
import { useT } from "../../lib/i18n";

export function PluginUnavailablePane({ reason, detail, onOpenSettings, children }: {
  reason: "missing" | "disabled" | "unavailable";
  detail?: string;
  onOpenSettings?: () => void;
  children?: ReactNode;
}) {
  const t = useT();
  return (
    <div data-testid="plugin-tab-unavailable" data-reason={reason} className="m-auto max-w-lg space-y-3 p-6 text-ui-body">
      <p className="font-semibold">{t(`plugins.${reason}`)}</p>
      <p className="break-words text-[var(--taomni-text-muted)]">{detail ?? t("plugins.retained")}</p>
      {onOpenSettings && <button type="button" data-testid="plugin-tab-settings" className="taomni-btn px-3 py-1" onClick={onOpenSettings}>{t("plugins.settings")}</button>}
      {children}
    </div>
  );
}
