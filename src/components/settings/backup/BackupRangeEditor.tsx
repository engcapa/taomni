import { useT } from "../../../lib/i18n";
import type { BackupCustomOptions, BackupScope } from "../../../lib/backup";
import { preset, rangeOptions, type BackupRange } from "../../../lib/backupSettings";

export const backupInput = "w-full rounded border border-theme-border bg-theme-bg p-2 text-xs text-theme-text";
export const backupButton = "rounded border border-theme-border px-3 py-1.5 text-xs text-theme-text hover:border-accent disabled:opacity-50";
const fields: (keyof BackupCustomOptions)[] = ["includeSessions", "includeNotes", "includeVault", "includeMfa", "includeConfigs", "includeLanchat", "includeMail", "includeLocalHistory"];

export function BackupRangeSummary({ value }: { value: BackupRange }) {
  const t = useT();
  const options = rangeOptions(value);
  return <p data-testid="backup-range-summary" className="text-xs text-theme-muted">{fields.filter((key) => options[key]).map((key) => t(`backupUnified.${key}`)).join(" · ") || t("backupUnified.emptyRange")}</p>;
}

export function BackupRangeEditor({ value, onChange, id = "backup-global", disabled = false }: {
  value: BackupRange; onChange: (value: BackupRange) => void; id?: string; disabled?: boolean;
}) {
  const t = useT();
  const options = rangeOptions(value);
  return <div className="space-y-2">
    <label className="block space-y-1 text-xs text-theme-muted"><span>{t("backupSettings.scopeLabel")}</span>
      <select data-testid={`${id}-scope`} aria-label={t("backupSettings.scopeLabel")} className={backupInput} value={value.scope} disabled={disabled} onChange={(e) => onChange(preset(e.target.value as BackupScope, value))}>
        {["core", "full", "custom"].map((scope) => <option key={scope} value={scope}>{t(`backupUnified.${scope}`)}</option>)}
      </select>
    </label>
    {value.scope === "custom" ? <div className="grid gap-2 sm:grid-cols-2">{fields.map((key) => <label key={key} className="flex items-center gap-2 text-xs text-theme-text">
      <input id={`${id}-${key}`} data-testid={`${id}-${key}`} type="checkbox" checked={options[key]} disabled={disabled || key === "includeVault" && options.includeMfa} onChange={(e) => {
        const next = { ...options, [key]: e.target.checked };
        if (next.includeMfa) next.includeVault = true;
        onChange({ scope: "custom", customOptions: next });
      }} />{t(`backupUnified.${key}`)}
    </label>)}</div> : <label className="flex items-center gap-2 text-xs text-theme-text">
      <input id={`${id}-include-mail`} data-testid={`${id}-include-mail`} type="checkbox" checked={options.includeMail} disabled={disabled} onChange={(e) => onChange({ ...value, customOptions: { includeMail: e.target.checked } })} />{t("backupSettings.includeMail")}
    </label>}
    <BackupRangeSummary value={value} />
    <p className="text-xs text-theme-muted">{t("backupUnified.rangeHint")}</p>
  </div>;
}
