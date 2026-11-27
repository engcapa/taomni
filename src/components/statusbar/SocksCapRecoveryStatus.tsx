import { TriangleAlert } from "lucide-react";
import { useT } from "../../lib/i18n";
import { openSettingsSection } from "../../lib/settingsNavigation";
import { useRecoveryStatus } from "../../lib/sockscap/useRecoveryStatus";

export function SocksCapRecoveryStatus() {
  const t = useT();
  const recovery = useRecoveryStatus();
  if (!recovery) return null;

  return (
    <button type="button" data-testid="status-sockscap-recovery"
      className="flex shrink-0 items-center gap-1 text-ui-warning"
      title={recovery.message} onClick={() => openSettingsSection("module-store")}>
      <TriangleAlert className="h-3 w-3" />
      {t("settings.moduleStoreSocksCapRecovery")}
    </button>
  );
}
