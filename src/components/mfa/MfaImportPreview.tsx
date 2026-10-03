import { useEffect, useMemo, useState } from "react";
import { useT } from "../../lib/i18n";
import { errorText } from "../../lib/mfa/format";
import type { MfaParsedItem } from "../../lib/mfa/otpauth";
import type { MfaAccountInput, MfaInspectItem } from "../../lib/mfa/types";
import { useMfaStore } from "../../stores/mfaStore";

interface Row {
  label: string;
  input: MfaAccountInput | null;
  error: string | null;
  duplicate: boolean;
  checked: boolean;
}

/** Review decoded accounts before writing them to mfa.db. */
export function MfaImportPreview({
  items,
  onBack,
  onImported,
}: {
  items: MfaParsedItem[];
  onBack: () => void;
  onImported: (count: number) => void;
}) {
  const t = useT();
  const inspect = useMfaStore((s) => s.inspect);
  const addAccounts = useMfaStore((s) => s.addAccounts);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [group, setGroup] = useState("");
  const [single, setSingle] = useState<{ issuer: string; accountName: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const valid = items.filter((item) => item.input !== null);
    void inspect(valid.map((item) => item.input as MfaAccountInput))
      .then((inspected: MfaInspectItem[]) => {
        if (cancelled) return;
        let cursor = 0;
        const next = items.map((item): Row => {
          if (!item.input) return { label: item.label, input: null, error: item.error, duplicate: false, checked: false };
          const result = inspected[cursor++];
          const rowError = result && !result.ok ? result.error : null;
          const duplicate = Boolean(result?.duplicateOf);
          return { label: item.label, input: item.input, error: rowError, duplicate, checked: !rowError && !duplicate };
        });
        setRows(next);
        const onlyValid = next.filter((row) => row.input);
        if (next.length === 1 && onlyValid.length === 1 && onlyValid[0].input) {
          setSingle({ issuer: onlyValid[0].input.issuer, accountName: onlyValid[0].input.accountName });
        }
      })
      .catch((err) => !cancelled && setError(errorText(err)));
    return () => {
      cancelled = true;
    };
  }, [inspect, items]);

  const selected = useMemo(() => (rows ?? []).filter((row) => row.checked && row.input), [rows]);
  const allDuplicates = !!rows && rows.length > 0 && rows.every((row) => row.duplicate || !row.input);

  const confirm = async () => {
    if (busy || selected.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const inputs = selected.map((row) => ({
        ...(row.input as MfaAccountInput),
        ...(single ?? {}),
        group: group.trim() || (row.input as MfaAccountInput).group,
      }));
      const result = await addAccounts(inputs, true);
      onImported(result.added.length);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const kindLabel = (input: MfaAccountInput) =>
    input.kind === "hotp"
      ? t("mfa.kindLabelHotp", { digits: input.digits, counter: input.counter })
      : t("mfa.kindLabelTotp", { digits: input.digits, period: input.period });

  return (
    <div data-testid="mfa-import-preview" className="space-y-3">
      <div className="text-[12px]" style={{ color: "var(--taomni-text-muted)" }}>
        {rows ? t("mfa.previewCount", { count: rows.length }) : t("mfa.previewChecking")}
      </div>
      <ul className="max-h-[220px] space-y-1 overflow-y-auto">
        {(rows ?? []).map((row, index) => (
          <li
            key={`${row.label}-${index}`}
            data-testid="mfa-import-item"
            data-issuer={row.input?.issuer ?? ""}
            data-duplicate={row.duplicate ? "true" : "false"}
            className="flex items-center gap-2 rounded border px-2 py-1.5 text-[12px]"
            style={{ borderColor: "var(--taomni-divider)" }}
          >
            <input
              type="checkbox"
              data-testid="mfa-import-item-check"
              aria-label={row.label}
              checked={row.checked}
              disabled={!row.input || !!row.error || row.duplicate}
              onChange={(event) =>
                setRows((current) => (current ?? []).map((entry, i) => (i === index ? { ...entry, checked: event.target.checked } : entry)))
              }
            />
            <div className="min-w-0 flex-1">
              <div data-testid="mfa-import-item-label" className="truncate font-semibold">{row.label}</div>
              {row.input ? <div style={{ color: "var(--taomni-text-muted)" }}>{kindLabel(row.input)}</div> : null}
              {row.error ? (
                <div data-testid="mfa-import-invalid" style={{ color: "var(--taomni-error, #c33)" }}>
                  {t("mfa.previewInvalid", { error: row.error })}
                </div>
              ) : null}
            </div>
            {row.duplicate ? (
              <span data-testid="mfa-import-duplicate" className="taomni-pill shrink-0 text-[10px]">{t("mfa.previewDuplicate")}</span>
            ) : null}
          </li>
        ))}
      </ul>
      {single ? (
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[12px]" style={{ color: "var(--taomni-text-muted)" }}>
            {t("mfa.issuer")}
            <input data-testid="mfa-import-issuer" className="taomni-input mt-1 w-full" value={single.issuer} onChange={(event) => setSingle({ ...single, issuer: event.target.value })} />
          </label>
          <label className="text-[12px]" style={{ color: "var(--taomni-text-muted)" }}>
            {t("mfa.accountName")}
            <input data-testid="mfa-import-account" className="taomni-input mt-1 w-full" value={single.accountName} onChange={(event) => setSingle({ ...single, accountName: event.target.value })} />
          </label>
        </div>
      ) : null}
      <label className="block text-[12px]" style={{ color: "var(--taomni-text-muted)" }}>
        {t("mfa.group")}
        <input data-testid="mfa-import-group" className="taomni-input mt-1 w-full" value={group} placeholder={t("mfa.groupPlaceholder")} onChange={(event) => setGroup(event.target.value)} />
      </label>
      {allDuplicates ? (
        <div data-testid="mfa-import-all-duplicates" className="text-[12px]" style={{ color: "var(--taomni-text-muted)" }}>
          {t("mfa.previewAllDuplicates")}
        </div>
      ) : null}
      {error ? <div data-testid="mfa-import-error" role="alert" className="text-[12px]" style={{ color: "var(--taomni-error, #c33)" }}>{error}</div> : null}
      <div className="flex justify-end gap-2">
        <button type="button" data-testid="mfa-import-back" className="px-3 py-1 text-[12px] rounded hover:bg-[var(--taomni-hover)]" onClick={onBack} disabled={busy}>
          {t("mfa.previewBack")}
        </button>
        <button
          type="button"
          data-testid="mfa-import-confirm"
          className="px-3 py-1 text-[12px] rounded text-white disabled:opacity-50"
          style={{ background: "var(--taomni-accent)" }}
          disabled={busy || selected.length === 0}
          onClick={() => void confirm()}
        >
          {t("mfa.previewImport", { count: selected.length })}
        </button>
      </div>
    </div>
  );
}
