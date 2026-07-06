import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ChevronDown } from "lucide-react";

interface Option {
  value: string | number;
  label: string;
  group?: string;
  style?: CSSProperties;
}

interface NotesSelectProps {
  value: string | number;
  options: readonly Option[] | Option[];
  onChange: (value: any) => void;
  className?: string;
  testId?: string;
  ariaLabel?: string;
  title?: string;
  selectBg?: string;
  selectColor?: string;
  selectBorder?: string;
}

export function NotesSelect({
  value,
  options,
  onChange,
  className = "",
  testId,
  ariaLabel,
  title,
  selectBg,
  selectColor,
  selectBorder,
}: NotesSelectProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.find((opt) => opt.value === value) ?? options[0];

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

  // Group options if any option has a group defined
  const groupedOptions: Array<{ group: string | null; options: Option[] }> = [];
  for (const option of options) {
    const groupName = option.group ?? null;
    const existingGroup = groupedOptions.find((g) => g.group === groupName);
    if (existingGroup) {
      existingGroup.options.push(option);
    } else {
      groupedOptions.push({ group: groupName, options: [option] });
    }
  }

  return (
    <div ref={rootRef} className={`relative inline-flex flex-col min-w-0 ${className}`}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={title}
        data-testid={testId}
        className="taomni-input h-6 w-full px-1.5 text-left flex items-center justify-between gap-1 select-none cursor-pointer"
        style={{
          backgroundColor: selectBg,
          color: selectColor,
          borderColor: selectBorder,
          ...selected?.style,
        }}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="truncate text-[11px] font-medium leading-none">
          {selected?.label}
        </span>
        <ChevronDown className="w-3 h-3 flex-shrink-0 opacity-70" style={{ color: selectColor }} />
      </button>
      {open && (
        <div
          role="listbox"
          data-testid={testId ? `${testId}-menu` : undefined}
          className="absolute left-0 right-0 z-50 mt-1 max-h-48 overflow-y-auto rounded border p-0.5 shadow-md flex flex-col gap-0.5"
          style={{
            backgroundColor: selectBg || "var(--taomni-input-bg)",
            color: selectColor || "var(--taomni-text)",
            borderColor: selectBorder || "var(--taomni-divider)",
          }}
        >
          {groupedOptions.map((group, groupIdx) => (
            <div key={group.group ?? `__ungrouped_${groupIdx}`} className="flex flex-col gap-0.5">
              {group.group && (
                <div className="px-2 pt-1 pb-0.5 text-[9px] font-semibold uppercase opacity-60 tracking-wider text-[var(--taomni-text-muted)]">
                  {group.group}
                </div>
              )}
              {group.options.map((option) => {
                const isSelected = option.value === value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    className="w-full h-6 px-1.5 text-left text-[11px] rounded flex items-center select-none cursor-pointer hover:bg-[var(--taomni-hover)] focus:bg-[var(--taomni-hover)] outline-none"
                    style={{
                      backgroundColor: isSelected ? "var(--taomni-selected)" : "transparent",
                      color: isSelected ? "var(--taomni-accent)" : selectColor,
                      ...option.style,
                    }}
                    onClick={() => {
                      onChange(option.value);
                      setOpen(false);
                    }}
                  >
                    <span className="truncate">{option.label}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
