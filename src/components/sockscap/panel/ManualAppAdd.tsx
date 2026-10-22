import { useState } from "react";
import { useT } from "../../../lib/i18n";


export function ManualAppAdd({
  onAdd,
  disabled,
}: {
  onAdd: (path: string) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const [path, setPath] = useState("");
  return (
    <div className="flex gap-1 flex-1 min-w-[200px]">
      <input
        className="flex-1 text-[11px] px-2 py-1 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)] disabled:opacity-60 disabled:cursor-not-allowed"
        placeholder={t("sockscap.appPathPh")}
        value={path}
        disabled={disabled}
        title={disabled ? t("sockscap.lockedTooltip") : undefined}
        onChange={(e) => setPath(e.target.value)}
      />
      <button
        type="button"
        className="px-2 py-1 rounded text-[11px] border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] disabled:opacity-50 disabled:cursor-not-allowed"
        disabled={disabled}
        title={disabled ? t("sockscap.lockedTooltip") : undefined}
        onClick={() => {
          if (path.trim()) {
            onAdd(path.trim());
            setPath("");
          }
        }}
      >
        {t("common.add")}
      </button>
    </div>
  );
}
