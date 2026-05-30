import type { ReactNode } from "react";
import { selectFolderPath, selectFilePath } from "../../lib/ipc";

/**
 * Reusable, controlled field primitives for the server settings forms. Every
 * form imports these so the per-type forms stay tiny and visually consistent.
 * All controls use the existing `.moba-input` / `.moba-checkbox` / `.moba-radio`
 * classes and `var(--moba-*)` tokens. Labels are passed in as plain strings
 * (callers resolve i18n via `useT()`), so these primitives carry no copy.
 */

const LABEL_WIDTH = 100;

/** A label + control row. Label is fixed-width, right-aligned, muted. */
export function FormRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 mb-1.5 text-[12px]">
      <label
        className="shrink-0 text-right"
        style={{ width: LABEL_WIDTH, color: "var(--moba-text-muted)" }}
      >
        {label}
      </label>
      <div className="flex items-center gap-1.5 flex-wrap min-w-0">{children}</div>
    </div>
  );
}

export interface NumberFieldProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  disabled?: boolean;
  width?: number;
}

export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step,
  placeholder,
  disabled,
  width = 90,
}: NumberFieldProps) {
  return (
    <FormRow label={label}>
      <input
        type="number"
        className="moba-input"
        style={{ width }}
        value={Number.isFinite(value) ? value : ""}
        min={min}
        max={max}
        step={step}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => {
          const parsed = parseInt(e.target.value || "0", 10);
          onChange(Number.isNaN(parsed) ? 0 : parsed);
        }}
      />
    </FormRow>
  );
}

export interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  width?: number | string;
}

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  disabled,
  width = "100%",
}: TextFieldProps) {
  return (
    <FormRow label={label}>
      <input
        type="text"
        className="moba-input"
        style={{ width, maxWidth: "100%" }}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </FormRow>
  );
}

export interface CheckboxFieldProps {
  label: string;
  /** Optional inline text shown next to the checkbox (right of the control). */
  checkboxLabel?: string;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}

export function CheckboxField({
  label,
  checkboxLabel,
  value,
  onChange,
  disabled,
}: CheckboxFieldProps) {
  return (
    <FormRow label={label}>
      <label className="flex items-center gap-1.5 text-[12px] cursor-pointer">
        <input
          type="checkbox"
          className="moba-checkbox"
          checked={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        {checkboxLabel ? (
          <span style={{ color: "var(--moba-text)" }}>{checkboxLabel}</span>
        ) : null}
      </label>
    </FormRow>
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  disabled?: boolean;
  width?: number;
}

export function SelectField({
  label,
  value,
  onChange,
  options,
  disabled,
  width = 160,
}: SelectFieldProps) {
  return (
    <FormRow label={label}>
      <select
        className="moba-input appearance-none"
        style={{ width }}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </FormRow>
  );
}

export interface PasswordFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  width?: number | string;
}

export function PasswordField({
  label,
  value,
  onChange,
  placeholder,
  disabled,
  width = 200,
}: PasswordFieldProps) {
  return (
    <FormRow label={label}>
      <input
        type="password"
        className="moba-input"
        style={{ width, maxWidth: "100%" }}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </FormRow>
  );
}

export interface PathFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** "folder" picks a directory, "file" picks a single file. */
  mode?: "folder" | "file";
  /** Text for the Browse button (caller resolves i18n). */
  browseLabel: string;
  placeholder?: string;
  disabled?: boolean;
}

export function PathField({
  label,
  value,
  onChange,
  mode = "folder",
  browseLabel,
  placeholder,
  disabled,
}: PathFieldProps) {
  const browse = async () => {
    try {
      const picked =
        mode === "file"
          ? await selectFilePath(value || undefined)
          : await selectFolderPath(value || undefined);
      if (picked) onChange(picked);
    } catch {
      // User cancelled or picker unavailable — leave the value unchanged.
    }
  };

  return (
    <FormRow label={label}>
      <input
        type="text"
        className="moba-input"
        style={{ width: 240, maxWidth: "100%" }}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        className="moba-btn"
        disabled={disabled}
        onClick={() => void browse()}
      >
        {browseLabel}
      </button>
    </FormRow>
  );
}

export interface RadioOption {
  value: string;
  label: string;
}

export interface RadioFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: RadioOption[];
  /** Stable name so the radios form a single group. */
  name: string;
  disabled?: boolean;
}

export function RadioField({
  label,
  value,
  onChange,
  options,
  name,
  disabled,
}: RadioFieldProps) {
  return (
    <FormRow label={label}>
      <div className="flex items-center gap-4">
        {options.map((opt) => (
          <label
            key={opt.value}
            className="flex items-center gap-1.5 text-[12px] cursor-pointer"
          >
            <input
              type="radio"
              className="moba-radio"
              name={name}
              value={opt.value}
              checked={value === opt.value}
              disabled={disabled}
              onChange={() => onChange(opt.value)}
            />
            <span style={{ color: "var(--moba-text)" }}>{opt.label}</span>
          </label>
        ))}
      </div>
    </FormRow>
  );
}

export interface FieldNoteProps {
  children: ReactNode;
  /** "warning" uses the amber warning tokens; "info" is muted. Default "info". */
  tone?: "info" | "warning";
}

/**
 * A small explanatory note shown beneath related fields (security warnings,
 * privilege hints, units). Indented to align under the field controls so it
 * reads as guidance for the row above it.
 */
export function FieldNote({ children, tone = "info" }: FieldNoteProps) {
  const warning = tone === "warning";
  return (
    <div
      className="flex items-start gap-1.5 text-[11px] rounded px-2 py-1.5 mb-1.5 leading-relaxed"
      style={{
        marginLeft: LABEL_WIDTH + 8,
        background: warning ? "var(--moba-warning-bg)" : "transparent",
        border: warning ? "1px solid var(--moba-warning-border)" : "none",
        color: warning ? "var(--moba-warning-text)" : "var(--moba-text-muted)",
      }}
    >
      <span>{children}</span>
    </div>
  );
}
