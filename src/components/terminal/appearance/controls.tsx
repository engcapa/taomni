import { Plus, Trash2 } from "lucide-react";
import { type UserCommonCommand } from "../../../lib/terminalProfile";
import { type CommonCommandsEditorProps } from "./model";

export function CheckControl({
  label,
  checked,
  onChange,
  testId,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  testId?: string;
}) {
  return (
    <label className="inline-flex items-center gap-1.5" data-testid={testId}>
      <input
        className="taomni-checkbox"
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

export function CommonCommandsEditor({ value, onChange, t }: CommonCommandsEditorProps) {
  const updateRow = (index: number, patch: Partial<UserCommonCommand>) => {
    const next = value.slice();
    const current = next[index] ?? { command: "" };
    next[index] = { ...current, ...patch };
    onChange(next);
  };
  const removeRow = (index: number) => {
    const next = value.slice();
    next.splice(index, 1);
    onChange(next);
  };
  const addRow = () => {
    onChange([...value, { command: "" }]);
  };

  return (
    <div className="flex flex-col gap-1.5">
      {value.length === 0 ? (
        <div className="text-[11px] text-[var(--taomni-text-muted)] italic px-1 py-2">
          {t("terminalAppearance.commonCommandsEmpty")}
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {value.map((item, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <input
                className="taomni-input flex-1 min-w-0 font-mono text-[12px]"
                placeholder={t("terminalAppearance.commonCommandPlaceholder")}
                value={item.command}
                onChange={(e) => updateRow(idx, { command: e.target.value })}
                aria-label={t("terminalAppearance.commonCommandAriaCommand", { index: idx + 1 })}
              />
              <input
                className="taomni-input flex-1 min-w-0 text-[12px]"
                placeholder={t("terminalAppearance.commonCommandDescriptionPlaceholder")}
                value={item.description ?? ""}
                onChange={(e) => updateRow(idx, { description: e.target.value })}
                aria-label={t("terminalAppearance.commonCommandAriaDescription", { index: idx + 1 })}
              />
              <button
                type="button"
                className="taomni-btn h-8 w-8 p-0 inline-flex items-center justify-center"
                onClick={() => removeRow(idx)}
                aria-label={t("terminalAppearance.commonCommandRemoveAria", { index: idx + 1 })}
                title={t("terminalAppearance.commonCommandRemove")}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
      <button
        type="button"
        className="taomni-btn h-8 px-2 text-[11px] self-start inline-flex items-center gap-1"
        onClick={addRow}
      >
        <Plus size={12} /> {t("terminalAppearance.commonCommandAddEntry")}
      </button>
    </div>
  );
}
