import { useEffect, useRef, type InputHTMLAttributes } from "react";
import { useT } from "../../../lib/i18n";
import type { BackupCustomOptions } from "../../../lib/backup";
import { rangeOptions, type BackupRange } from "../../../lib/backupSettings";

export const backupInput = "w-full rounded border border-theme-border bg-theme-bg p-2 text-xs text-theme-text";
export const backupButton = "rounded border border-theme-border px-3 py-1.5 text-xs text-theme-text hover:border-accent disabled:opacity-50";
type Key = keyof BackupCustomOptions;
const fields: Key[] = ["includeSessions", "includeNotes", "includeVault", "includeMfa", "includeConfigs", "includeServerCertificates", "includeLanchat", "includeLocalHistory"];
const mailFields: Key[] = ["includeMail", "includeMailOriginals", "includeMailAttachments"];

function CategoryCheckbox({ mixed = false, ...props }: InputHTMLAttributes<HTMLInputElement> & { mixed?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = mixed; }, [mixed]);
  return <input {...props} ref={ref} type="checkbox" aria-checked={mixed ? "mixed" : !!props.checked} />;
}

export function BackupRangeSummary({ value }: { value: BackupRange }) {
  const t = useT();
  const options = rangeOptions(value);
  return <p data-testid="backup-range-summary" className="text-xs text-theme-muted">{[...fields, ...mailFields].filter((key) => options[key]).map((key) => t(`backupUnified.${key === "includeMail" ? "mailCache" : key}`)).join(" · ") || t("backupUnified.emptyRange")}</p>;
}

export function BackupRangeEditor({ value, onChange, id = "backup-global", disabled = false }: {
  value: BackupRange; onChange: (value: BackupRange) => void; id?: string; disabled?: boolean;
}) {
  const t = useT();
  const options = rangeOptions(value);
  const selectedMail = mailFields.filter((key) => options[key]).length;
  const change = (keys: Key[], checked: boolean) => {
    const next = { ...options };
    keys.forEach((key) => { next[key] = checked; });
    if (next.includeMfa) next.includeVault = true;
    if (next.includeMailOriginals || next.includeMailAttachments) next.includeMail = true;
    onChange({ scope: "custom", customOptions: next });
  };
  const row = (key: Key, mail = false) => <label key={key} className="flex items-start gap-2 text-xs text-theme-text">
    <CategoryCheckbox id={`${id}-${key}`} data-testid={`${id}-${key}`} checked={options[key]}
      disabled={disabled || key === "includeVault" && options.includeMfa || key === "includeMail" && (options.includeMailOriginals || options.includeMailAttachments)}
      onChange={(e) => change([key], e.target.checked)} />
    <span>{t(`backupUnified.${mail && key === "includeMail" ? "mailCache" : key}`)}</span>
  </label>;
  return <fieldset disabled={disabled} className="space-y-3" data-testid={`${id}-categories`}>
    <legend className="mb-2 text-xs text-theme-muted">{t("backupUnified.categories")}</legend>
    <div className="grid gap-3 sm:grid-cols-2">{fields.map((key) => row(key))}</div>
    <div className="space-y-2 rounded border border-theme-border p-3">
      <label className="flex items-center gap-2 text-xs font-medium text-theme-text">
        <CategoryCheckbox id={`${id}-include-mail`} data-testid={`${id}-include-mail`} checked={selectedMail === mailFields.length} mixed={selectedMail > 0 && selectedMail < mailFields.length}
          onChange={(e) => change(mailFields, e.target.checked)} />{t("backupUnified.includeMail")}
      </label>
      <div className="ml-2 space-y-2 border-l border-theme-border pl-4">{mailFields.map((key) => row(key, true))}</div>
    </div>
    <BackupRangeSummary value={value} />
    <p className="text-xs text-theme-muted">{t("backupUnified.rangeHint")}</p>
  </fieldset>;
}
