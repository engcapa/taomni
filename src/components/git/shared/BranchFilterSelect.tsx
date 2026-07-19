import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Search } from "lucide-react";
import { sortByDateThenName, type DatedNamed } from "../../../lib/gitRefList";

export interface BranchFilterOption extends DatedNamed {
  /** Option value (branch name, or special keys). */
  value: string;
  /** Display label; defaults to `name` / `value`. */
  label?: string;
}

export interface BranchFilterSelectProps {
  value: string;
  onChange: (value: string) => void;
  /** Branch options (special Current/All are always prepended). */
  branches: readonly BranchFilterOption[];
  className?: string;
  /** Width class for the trigger; default `w-44`. */
  widthClass?: string;
  "aria-label"?: string;
  testId?: string;
}

const SPECIALS: BranchFilterOption[] = [
  { value: "__current__", name: "Current branch", label: "Current branch" },
  { value: "__all__", name: "All branches", label: "All branches" },
];

export function BranchFilterSelect({
  value,
  onChange,
  branches,
  className = "",
  widthClass = "w-44",
  "aria-label": ariaLabel = "Branch",
  testId = "git-branch-filter",
}: BranchFilterSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const sortedBranches = useMemo(
    () => sortByDateThenName(branches),
    [branches],
  );

  const selectedLabel = useMemo(() => {
    const special = SPECIALS.find((item) => item.value === value);
    if (special) return special.label ?? special.name;
    const branch = sortedBranches.find((item) => item.value === value);
    return branch?.label ?? branch?.name ?? value;
  }, [sortedBranches, value]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = [...SPECIALS, ...sortedBranches];
    if (!q) return list;
    return list.filter((item) => {
      const hay = `${item.label ?? ""} ${item.name} ${item.value}`.toLowerCase();
      return hay.includes(q);
    });
  }, [query, sortedBranches]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || !rootRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={`relative inline-flex min-w-0 ${widthClass} ${className}`}>
      <button
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-testid={testId}
        className="taomni-input h-7 w-full px-2 text-left inline-flex items-center gap-1"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="min-w-0 flex-1 truncate text-[12px]">{selectedLabel}</span>
        <ChevronDown className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-text-muted)]" />
      </button>
      {open && (
        <div
          role="listbox"
          data-testid={`${testId}-menu`}
          className="absolute right-0 top-full z-50 mt-1 w-[min(280px,max(100%,220px))] max-h-64 flex flex-col overflow-hidden rounded border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] shadow-lg"
        >
          <div className="shrink-0 border-b border-[var(--taomni-divider)] p-1.5">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--taomni-text-muted)]" />
              <input
                ref={inputRef}
                type="search"
                className="taomni-input h-7 w-full pl-7 text-[12px]"
                placeholder="Filter branches"
                aria-label="Filter branches"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.stopPropagation();
                    setOpen(false);
                  }
                }}
              />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-0.5">
            {filtered.length === 0 ? (
              <div className="px-2 py-3 text-center text-[11px] text-[var(--taomni-text-muted)]">
                No matching branches
              </div>
            ) : (
              filtered.map((item) => {
                const isSelected = item.value === value;
                const isSpecial = item.value === "__current__" || item.value === "__all__";
                return (
                  <button
                    key={item.value}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    data-testid={`${testId}-option`}
                    data-value={item.value}
                    className={`w-full h-7 px-2 text-left text-[12px] rounded flex items-center gap-1 cursor-pointer outline-none ${
                      isSelected
                        ? "bg-[var(--taomni-accent)]/15 text-[var(--taomni-accent)]"
                        : "hover:bg-[var(--taomni-hover)]"
                    } ${isSpecial ? "font-medium" : ""}`}
                    onClick={() => {
                      onChange(item.value);
                      setOpen(false);
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate">{item.label ?? item.name}</span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
