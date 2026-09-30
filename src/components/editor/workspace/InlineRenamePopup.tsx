import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

/** ED-PARITY-017 DEC-017-02/03/04: in-place naming overlay for Rename / Extract. */
export interface InlineRenameAnchor {
  left: number;
  top: number;
  height: number;
  fontFamily: string;
  fontSize: string;
}

export interface InlineRenamePopupProps {
  kind: "rename" | "extract";
  anchor: InlineRenameAnchor;
  initialValue: string;
  suggestions: readonly string[];
  /** Provider or validation error carried over from a previous attempt. */
  initialError?: string | null;
  validate: (name: string) => string | null;
  /** DEC-017-01: true when refactoring options are set to modal dialogs. */
  modalOptions: boolean;
  onCommit: (name: string) => void;
  onCancel: () => void;
  onOpenDialog: (value: string) => void;
  onToggleModalOptions: (modal: boolean) => void;
}

export function InlineRenamePopup({
  kind,
  anchor,
  initialValue,
  suggestions,
  initialError = null,
  validate,
  modalOptions,
  onCommit,
  onCancel,
  onOpenDialog,
  onToggleModalOptions,
}: InlineRenamePopupProps) {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(initialError);
  const [listOpen, setListOpen] = useState(suggestions.length > 0);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  // A press outside the session ends it like Escape (zero modification).
  useEffect(() => {
    const onPointer = (event: MouseEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (target && rootRef.current?.contains(target)) return;
      cancelRef.current();
    };
    document.addEventListener("mousedown", onPointer, true);
    return () => document.removeEventListener("mousedown", onPointer, true);
  }, []);

  const refocusInput = () => {
    window.requestAnimationFrame(() => inputRef.current?.focus());
  };

  const commit = () => {
    const name = value.trim();
    const problem = validate(name);
    if (problem) {
      setError(problem);
      return;
    }
    onCommit(name);
  };

  const pick = (index: number) => {
    const next = suggestions[index];
    if (next === undefined) return;
    setActiveIndex(index);
    setValue(next);
    setError(null);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    const key = event.key;
    const handled = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (key === "Escape") {
      handled();
      // IDEA R6: the first Escape only closes the suggestion list.
      if (optionsOpen) setOptionsOpen(false);
      else if (listOpen) setListOpen(false);
      else onCancel();
      return;
    }
    if (key === "Enter") {
      handled();
      commit();
      return;
    }
    if (key === "F6" && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
      handled();
      onOpenDialog(value);
      return;
    }
    if ((key === "o" || key === "O" || event.code === "KeyO") && event.altKey && event.shiftKey) {
      handled();
      setOptionsOpen((open) => !open);
      return;
    }
    if (key === "ArrowDown" || key === "ArrowUp") {
      handled();
      if (suggestions.length === 0) return;
      if (!listOpen) {
        setListOpen(true);
        return;
      }
      const delta = key === "ArrowDown" ? 1 : -1;
      const next = activeIndex < 0
        ? (delta > 0 ? 0 : suggestions.length - 1)
        : (activeIndex + delta + suggestions.length) % suggestions.length;
      pick(next);
    }
  };

  const hint = kind === "extract"
    ? "Press Alt+Shift+O to show options popup · Shift+F6 opens the dialog"
    : "Press Shift+F6 again to open the dialog · Alt+Shift+O to show options";

  return (
    <div
      ref={rootRef}
      data-testid="code-workspace-inline-rename"
      data-kind={kind}
      data-list-open={listOpen ? "true" : "false"}
      data-options-open={optionsOpen ? "true" : "false"}
      className="fixed z-[70]"
      style={{ left: anchor.left - 3, top: anchor.top - 2 }}
    >
      <input
        ref={inputRef}
        data-testid="code-workspace-inline-rename-input"
        role="combobox"
        aria-label={kind === "extract" ? "Method name" : "New name"}
        aria-expanded={listOpen}
        aria-controls={listOpen ? listId : undefined}
        aria-activedescendant={listOpen && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
        aria-invalid={error ? true : undefined}
        spellCheck={false}
        autoComplete="off"
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          setError(null);
          setActiveIndex(-1);
        }}
        onKeyDown={onKeyDown}
        className="rounded-[2px] border border-[var(--taomni-code-accent,#3574f0)] bg-[var(--taomni-code-bg)] px-[2px] text-[var(--taomni-code-fg)] outline-none"
        style={{
          fontFamily: anchor.fontFamily,
          fontSize: anchor.fontSize,
          height: anchor.height + 4,
          width: `calc(${Math.max(value.length, 1) + 2}ch + 6px)`,
        }}
      />
      {error && (
        <div
          data-testid="code-workspace-inline-rename-error"
          role="alert"
          className="mt-1 max-w-[360px] rounded border border-[var(--taomni-code-error,#e5484d)] bg-[var(--taomni-code-popup-bg,var(--taomni-code-bg))] px-2 py-1 text-[11px] text-[var(--taomni-code-fg)] shadow"
        >
          {error}
        </div>
      )}
      {(listOpen || !error) && (
        <div className="mt-1 min-w-[200px] max-w-[360px] rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-popup-bg,var(--taomni-code-bg))] text-[12px] shadow-lg">
          {listOpen && suggestions.length > 0 && (
            <ul
              id={listId}
              role="listbox"
              aria-label="Name suggestions"
              data-testid="code-workspace-inline-rename-suggestions"
              className="py-1"
            >
              {suggestions.map((suggestion, index) => (
                <li
                  key={suggestion}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === activeIndex}
                  data-testid="code-workspace-inline-rename-suggestion"
                  data-value={suggestion}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    pick(index);
                    refocusInput();
                  }}
                  className={`cursor-default px-2 py-0.5 font-mono ${index === activeIndex ? "bg-[var(--taomni-code-selection-bg,#2f65ca)] text-white" : ""}`}
                >
                  {suggestion}
                </li>
              ))}
            </ul>
          )}
          <div
            data-testid="code-workspace-inline-rename-hint"
            className="border-t border-[var(--taomni-code-border)] px-2 py-1 text-[11px] text-[var(--taomni-code-muted)]"
          >
            {hint}
          </div>
        </div>
      )}
      {optionsOpen && (
        <div
          data-testid="code-workspace-inline-rename-options"
          role="group"
          aria-label="Rename options"
          className="mt-1 w-[320px] rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-popup-bg,var(--taomni-code-bg))] p-2 text-[12px] shadow-lg"
        >
          <label
            className="flex items-start gap-2 opacity-60"
            title="The language server rename has no comments/strings option"
          >
            <input
              type="checkbox"
              disabled
              checked={false}
              readOnly
              data-testid="code-workspace-inline-rename-option-comments"
            />
            <span>
              Rename in comments and strings
              <span
                data-testid="code-workspace-inline-rename-option-comments-reason"
                className="block text-[11px] text-[var(--taomni-code-muted)]"
              >
                Not supported by the language server rename
              </span>
            </span>
          </label>
          <label className="mt-1 flex items-center gap-2">
            <input
              type="checkbox"
              data-testid="code-workspace-inline-rename-option-modal"
              data-checked={modalOptions ? "true" : "false"}
              checked={modalOptions}
              onChange={(event) => {
                onToggleModalOptions(event.target.checked);
                refocusInput();
              }}
            />
            <span>Specify refactoring options in modal dialogs</span>
          </label>
          <button
            type="button"
            data-testid="code-workspace-inline-rename-open-dialog"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onOpenDialog(value)}
            className="mt-2 flex w-full items-center justify-between rounded px-1 py-0.5 text-left hover:bg-[var(--taomni-code-active-line-bg)]"
          >
            <span>{kind === "extract" ? "Open Extract Method Dialog…" : "Open Rename Dialog…"}</span>
            <kbd className="text-[11px] text-[var(--taomni-code-muted)]">Shift+F6</kbd>
          </button>
        </div>
      )}
    </div>
  );
}
