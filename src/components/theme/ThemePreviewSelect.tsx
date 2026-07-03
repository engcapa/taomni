import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";

export interface ThemePreviewOption {
  value: string;
  label: string;
  group?: string;
  preview: ReactNode;
  testId?: string;
}

interface ThemePreviewSelectProps {
  value: string;
  options: ThemePreviewOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  testId?: string;
  title?: string;
  className?: string;
  menuClassName?: string;
}

export function ThemePreviewSelect({
  value,
  options,
  onChange,
  ariaLabel,
  testId,
  title,
  className = "",
  menuClassName = "",
}: ThemePreviewSelectProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || !rootRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={title}
        data-testid={testId}
        className="taomni-input h-auto min-h-10 w-full px-2 py-1.5 text-left flex items-center gap-2"
        onClick={() => setOpen((current) => !current)}
      >
        {selected ? (
          <>
            <span className="min-w-[120px] max-w-[42%] truncate text-[12px] font-semibold">
              {selected.label}
            </span>
            <span className="min-w-0 flex-1 overflow-hidden">{selected.preview}</span>
          </>
        ) : (
          <span className="text-[12px] text-[var(--taomni-text-muted)]">{ariaLabel}</span>
        )}
        <ChevronDown className="w-3.5 h-3.5 flex-shrink-0 text-[var(--taomni-text-muted)]" />
      </button>
      {open && (
        <div
          data-testid={testId ? `${testId}-menu` : undefined}
          className={`absolute left-0 right-0 z-50 mt-1 rounded-md border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] shadow-lg max-h-[320px] overflow-auto p-1 ${menuClassName}`}
        >
          <ThemePreviewList
            value={value}
            options={options}
            onChange={(next) => {
              onChange(next);
              setOpen(false);
            }}
          />
        </div>
      )}
    </div>
  );
}

export function ThemePreviewList({
  value,
  options,
  onChange,
  testId,
  className = "",
}: {
  value: string;
  options: ThemePreviewOption[];
  onChange: (value: string) => void;
  testId?: string;
  className?: string;
}) {
  const grouped: Array<{ group: string | null; options: ThemePreviewOption[] }> = [];
  for (const option of options) {
    const group = option.group ?? null;
    const existing = grouped.find((item) => item.group === group);
    if (existing) {
      existing.options.push(option);
    } else {
      grouped.push({ group, options: [option] });
    }
  }

  return (
    <div role="listbox" data-testid={testId} className={`space-y-1 ${className}`}>
      {grouped.map((group) => (
        <div key={group.group ?? "__ungrouped"} className="space-y-1">
          {group.group && (
            <div className="px-2 pt-1 text-[10px] font-semibold uppercase text-[var(--taomni-text-muted)]">
              {group.group}
            </div>
          )}
          {group.options.map((option) => (
            <ThemePreviewOptionRow
              key={`${group.group ?? "theme"}:${option.value}:${option.label}`}
              option={option}
              selected={option.value === value}
              onSelect={() => onChange(option.value)}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function ThemePreviewOptionRow({
  option,
  selected,
  onSelect,
}: {
  option: ThemePreviewOption;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      data-testid={option.testId}
      className="w-full min-h-10 rounded px-2 py-1.5 text-left flex items-center gap-2 hover:bg-[var(--taomni-hover)]"
      style={{
        background: selected ? "var(--taomni-selected)" : undefined,
        color: selected ? "var(--taomni-accent)" : undefined,
      }}
      onClick={onSelect}
    >
      <span className="w-4 flex-shrink-0 inline-flex items-center justify-center">
        {selected && <Check className="w-3.5 h-3.5" />}
      </span>
      <span className="min-w-[118px] max-w-[40%] truncate text-[12px] font-semibold">
        {option.label}
      </span>
      <span className="min-w-0 flex-1 overflow-hidden">{option.preview}</span>
    </button>
  );
}
