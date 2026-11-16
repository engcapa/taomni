import { Package } from "lucide-react";
import { useT } from "../../lib/i18n";
import { openSettingsSection } from "../../lib/settingsNavigation";

export function BrowseModulesButton({ onOpenSettings, className = "taomni-btn inline-flex items-center gap-1 px-3 py-1 text-[12px]" }: {
  onOpenSettings?: () => void;
  className?: string;
}) {
  const t = useT();
  const label = t("plugins.browse");
  return (
    <button
      type="button"
      data-testid="welcome-browse-modules"
      className={className}
      aria-label={label}
      title={label}
      onClick={() => {
        openSettingsSection("module-store");
        onOpenSettings?.();
      }}
    >
      <Package size={14} aria-hidden="true" />
      {label}
    </button>
  );
}
