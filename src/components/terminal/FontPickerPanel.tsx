import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Search } from "lucide-react";
import { useT } from "../../lib/i18n";

export interface FontPickerOption {
  value: string;
  label: string;
  fontFamily?: string;
  group?: string;
}

interface FontPickerSelectProps {
  options: FontPickerOption[];
  selectedValue: string;
  onSelect: (value: string) => void;
  ariaLabel: string;
  testId?: string;
  id?: string;
  onOpen?: () => void;
  groupForOption?: (option: FontPickerOption) => string;
  groupLabels?: Record<string, string>;
  loading?: boolean;
  className?: string;
}

const OPTION_HEIGHT = 32;
const GROUP_HEIGHT = 24;
const VIEWPORT_HEIGHT = 300;
const OVERSCAN_PX = 96;
const EMPTY_GROUP_LABELS: Record<string, string> = {};

export function FontPickerSelect({
  options,
  selectedValue,
  onSelect,
  ariaLabel,
  testId,
  id,
  onOpen,
  groupForOption,
  groupLabels,
  loading = false,
  className = "",
}: FontPickerSelectProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelPosition, setPanelPosition] = useState<CSSProperties | null>(null);
  const selected = options.find((option) => option.value === selectedValue);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (
        !(target instanceof Node)
        || (!rootRef.current?.contains(target) && !panelRef.current?.contains(target))
      ) {
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

  useLayoutEffect(() => {
    if (!open) {
      setPanelPosition(null);
      return;
    }
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.max(260, rect.width);
    const left = Math.max(6, Math.min(rect.left, window.innerWidth - width - 6));
    const estimatedHeight = 354;
    const top = rect.bottom + estimatedHeight <= window.innerHeight - 6
      ? rect.bottom + 4
      : Math.max(6, rect.top - estimatedHeight - 4);
    setPanelPosition({ position: "fixed", left, top, width, zIndex: 10_050 });
  }, [open, options.length]);

  const toggleOpen = () => {
    setOpen((current) => {
      const next = !current;
      if (next) onOpen?.();
      return next;
    });
  };

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        id={id}
        data-testid={testId}
        className="taomni-input h-8 w-full px-2 text-left inline-flex items-center gap-2"
        onClick={toggleOpen}
      >
        <span
          className="min-w-0 flex-1 truncate"
          style={{ fontFamily: selected?.fontFamily }}
        >
          {selected?.label ?? selectedValue}
        </span>
        {loading && open && <span className="text-[10px] text-[var(--taomni-text-muted)]">…</span>}
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--taomni-text-muted)]" />
      </button>
      {open && panelPosition && createPortal(
        <div ref={panelRef} data-taomni-context-menu="" style={panelPosition}>
          <FontPickerPanel
            options={options}
            selectedValue={selectedValue}
            onSelect={(value) => {
              onSelect(value);
              setOpen(false);
            }}
            groupForOption={groupForOption}
            groupLabels={groupLabels}
          />
        </div>,
        document.body,
      )}
    </div>
  );
}

interface FontPickerPanelProps {
  options: FontPickerOption[];
  selectedValue: string;
  onSelect: (value: string) => void;
  groupForOption?: (option: FontPickerOption) => string;
  groupLabels?: Record<string, string>;
}

type VirtualRow =
  | { kind: "group"; key: string; label: string; top: number; height: number }
  | { kind: "option"; key: string; option: FontPickerOption; top: number; height: number };

export function FontPickerPanel({
  options,
  selectedValue,
  onSelect,
  groupForOption,
  groupLabels = EMPTY_GROUP_LABELS,
}: FontPickerPanelProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [scrollTop, setScrollTop] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const t = useT();

  useEffect(() => {
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  const filteredOptions = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return options;
    return options.filter((option) => option.label.toLowerCase().includes(query));
  }, [options, searchQuery]);

  const { rows, totalHeight } = useMemo(() => {
    const grouped = new Map<string, FontPickerOption[]>();
    for (const option of filteredOptions) {
      const group = option.group ?? groupForOption?.(option) ?? "fonts";
      const entries = grouped.get(group);
      if (entries) entries.push(option);
      else grouped.set(group, [option]);
    }

    const nextRows: VirtualRow[] = [];
    let top = 0;
    for (const [group, groupOptions] of grouped) {
      const label = groupLabels[group] ?? group;
      if (label) {
        nextRows.push({ kind: "group", key: `group:${group}`, label, top, height: GROUP_HEIGHT });
        top += GROUP_HEIGHT;
      }
      for (const option of groupOptions) {
        nextRows.push({
          kind: "option",
          key: `option:${option.value}`,
          option,
          top,
          height: OPTION_HEIGHT,
        });
        top += OPTION_HEIGHT;
      }
    }
    return { rows: nextRows, totalHeight: top };
  }, [filteredOptions, groupForOption, groupLabels]);

  const visibleRows = useMemo(() => {
    const min = Math.max(0, scrollTop - OVERSCAN_PX);
    const max = scrollTop + VIEWPORT_HEIGHT + OVERSCAN_PX;
    return rows.filter((row) => row.top + row.height >= min && row.top <= max);
  }, [rows, scrollTop]);

  useEffect(() => {
    setScrollTop(0);
  }, [searchQuery]);

  return (
    <div
      className="flex w-full flex-col rounded border text-[12px] shadow-lg"
      style={{
        background: "var(--taomni-panel-bg)",
        borderColor: "var(--taomni-divider)",
        color: "var(--taomni-text)",
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="border-b p-2" style={{ borderColor: "var(--taomni-divider)" }}>
        <div className="relative flex items-center">
          <Search className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-[var(--taomni-text-muted)]" />
          <input
            ref={inputRef}
            type="search"
            aria-label={t("fontPicker.searchPlaceholder")}
            placeholder={t("fontPicker.searchPlaceholder")}
            className="taomni-input h-7 w-full pl-7 text-[12px] font-normal"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="px-3 py-4 text-center italic text-[var(--taomni-text-muted)]">
          {t("fontPicker.noResults")}
        </div>
      ) : (
        <div
          role="listbox"
          className="overflow-y-auto"
          style={{ height: Math.min(VIEWPORT_HEIGHT, totalHeight), scrollbarWidth: "thin" }}
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        >
          <div className="relative" style={{ height: totalHeight }}>
            {visibleRows.map((row) => (
              <VirtualFontRow
                key={row.key}
                row={row}
                selectedValue={selectedValue}
                onSelect={onSelect}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function VirtualFontRow({
  row,
  selectedValue,
  onSelect,
}: {
  row: VirtualRow;
  selectedValue: string;
  onSelect: (value: string) => void;
}) {
  const position: CSSProperties = {
    position: "absolute",
    left: 0,
    right: 0,
    top: row.top,
    height: row.height,
  };

  if (row.kind === "group") {
    return (
      <div
        style={position}
        className="flex items-center bg-black/5 px-3 text-[10px] font-bold uppercase tracking-wider text-[var(--taomni-text-muted)]"
      >
        {row.label}
      </div>
    );
  }

  const selected = row.option.value === selectedValue;
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      style={{ ...position, fontFamily: row.option.fontFamily }}
      className="flex w-full items-center gap-2 px-3 text-left hover:bg-[var(--taomni-hover)]"
      onClick={() => onSelect(row.option.value)}
    >
      <span className="flex w-4 shrink-0 items-center justify-center">
        {selected && <Check className="h-3.5 w-3.5 text-[var(--taomni-accent)]" />}
      </span>
      <span className="min-w-0 flex-1 truncate">{row.option.label}</span>
    </button>
  );
}
