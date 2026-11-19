import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import "./themedSelect.css";

interface Option<Value extends string> {
  value: Value;
  label: string;
  disabled?: boolean;
}

export function ThemedSelect<Value extends string>({ value, options, onChange, label, testId, className = "", disabled = false }: {
  value: Value;
  options: readonly Option<Value>[];
  onChange: (value: Value) => void;
  label: string;
  testId?: string;
  className?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const triggerId = `${id}-trigger`, popupId = `${id}-options`;
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [highlighted, setHighlighted] = useState<number | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0, minWidth: 120, maxHeight: 280 });
  const selected = options.findIndex((option) => option.value === value);
  const available = options.flatMap((option, index) => option.disabled ? [] : [index]);
  const open = !disabled && highlighted !== null;
  const close = () => setHighlighted(null);
  const show = (reverse = false) => setHighlighted(
    available.includes(selected) ? selected : (reverse ? available.at(-1) : available[0]) ?? null,
  );
  const pick = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    close();
    onChange(option.value);
  };

  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      const menu = popup.current;
      if (!anchor || !menu) return;
      const margin = 8;
      const below = window.innerHeight - anchor.bottom - margin;
      const above = anchor.top - margin;
      const upward = below < Math.min(280, menu.scrollHeight + 2) && above > below;
      const maxHeight = Math.max(32, Math.min(280, (upward ? above : below) - 4));
      const height = Math.min(maxHeight, menu.scrollHeight + 2);
      const width = Math.min(window.innerWidth - 2 * margin, Math.max(anchor.width, menu.offsetWidth, 120));
      const next = {
        left: Math.max(margin, Math.min(anchor.left, window.innerWidth - width - margin)),
        top: Math.max(margin, upward ? anchor.top - height - 4 : anchor.bottom + 4),
        minWidth: Math.min(window.innerWidth - 2 * margin, Math.max(anchor.width, 120)),
        maxHeight,
      };
      setPosition((old) => old.left === next.left && old.top === next.top
        && old.minWidth === next.minWidth && old.maxHeight === next.maxHeight ? old : next);
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !trigger.current?.contains(event.target) && !popup.current?.contains(event.target)) close();
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("blur", close);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (open) popup.current?.querySelector<HTMLElement>("[data-highlighted]")?.scrollIntoView?.({ block: "nearest" });
  }, [open, highlighted]);

  const keyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.nativeEvent.isComposing || event.ctrlKey || event.metaKey) return;
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      if (highlighted === null) show();
      else pick(highlighted);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Home") setHighlighted(available[0] ?? null);
      else if (event.key === "End") setHighlighted(available.at(-1) ?? null);
      else if (highlighted === null) show(event.key === "ArrowUp");
      else {
        const offset = event.key === "ArrowDown" ? 1 : -1;
        const next = Math.max(0, Math.min(available.length - 1, available.indexOf(highlighted) + offset));
        setHighlighted(available[next] ?? null);
      }
    } else if (open && event.key.length === 1 && !event.altKey) {
      const match = available.find((index) => options[index].label.toLocaleLowerCase().startsWith(event.key.toLocaleLowerCase()));
      if (match !== undefined) {
        event.preventDefault();
        event.stopPropagation();
        setHighlighted(match);
      }
    }
  };

  return <>
    <button ref={trigger} type="button" id={triggerId} role="combobox" aria-label={label} title={label}
      className={`taomni-select-trigger ${className}`} data-testid={testId} data-value={value}
      disabled={disabled || !available.length} aria-expanded={open} aria-haspopup="listbox"
      aria-controls={open ? popupId : undefined} aria-activedescendant={open ? `${popupId}-${highlighted}` : undefined}
      onBlur={(event) => { if (!popup.current?.contains(event.relatedTarget)) close(); }} onClick={(event) => {
        event.currentTarget.focus({ preventScroll: true });
        if (open) close();
        else show();
      }} onKeyDown={keyDown}>
      <span>{options[selected]?.label ?? label}</span><ChevronDown aria-hidden="true" />
    </button>
    {open && createPortal(<div ref={popup} id={popupId} role="listbox" aria-labelledby={triggerId}
      data-testid={testId ? `${testId}-options` : undefined} className="taomni-select-options" style={position}>
      {options.map((option, index) => <button key={option.value} type="button" id={`${popupId}-${index}`} role="option"
        aria-selected={index === selected} tabIndex={-1} disabled={option.disabled} data-value={option.value}
        data-highlighted={index === highlighted ? "" : undefined} onMouseDown={(event) => event.preventDefault()}
        onClick={() => pick(index)}>
        <span>{option.label}</span>{index === selected && <Check aria-hidden="true" />}
      </button>)}
    </div>, document.body)}
  </>;
}
