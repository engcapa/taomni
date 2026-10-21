import { ChevronDown } from "lucide-react";


/* ------------------------------------------------------------------ */
/*  Tiny local UI primitives (match prototype)                         */
/* ------------------------------------------------------------------ */

export function Checkbox({
  checked,
  onChange,
  disabled,
  dataTestId,
}: {
  checked: boolean;
  onChange?: (v: boolean) => void;
  disabled?: boolean;
  dataTestId?: string;
}) {
  return (
    <input
      type="checkbox"
      className="taomni-checkbox"
      data-testid={dataTestId}
      data-checked={checked}
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange?.(event.target.checked)}
    />
  );
}


export function Radio({
  checked,
  onChange,
  dataTestId,
}: {
  checked: boolean;
  onChange?: () => void;
  dataTestId?: string;
}) {
  return (
    <input
      type="radio"
      className="taomni-radio"
      data-testid={dataTestId}
      checked={checked}
      onChange={onChange}
    />
  );
}


export type SelectOption = string | { value: string; label: string };


export function selectOptionValue(option: SelectOption): string {
  return typeof option === "string" ? option : option.value;
}


export function selectOptionLabel(option: SelectOption): string {
  return typeof option === "string" ? option : option.label;
}


export function Select({
  value,
  options,
  onChange,
  className = "",
  ariaLabel,
  dataTestId,
}: {
  value: string;
  options: SelectOption[];
  onChange?: (v: string) => void;
  className?: string;
  ariaLabel?: string;
  dataTestId?: string;
}) {
  return (
    <span className="relative inline-flex items-center">
      <select
        data-testid={dataTestId}
        className={`taomni-input pr-6 appearance-none ${className || "w-[260px]"}`}
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
      >
        {options.map((o) => (
          <option key={selectOptionValue(o)} value={selectOptionValue(o)}>
            {selectOptionLabel(o)}
          </option>
        ))}
      </select>
      <ChevronDown className="w-3 h-3 absolute right-1 top-1/2 -translate-y-1/2 pointer-events-none text-[var(--taomni-text-muted)]" />
    </span>
  );
}


export function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <div className="col-span-3 text-[12px] text-right pt-1 text-[var(--taomni-text)]">
        {label}
      </div>
      <div className="col-span-9 flex items-center flex-wrap gap-1">
        {children}
      </div>
    </>
  );
}
