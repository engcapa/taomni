import { useEffect, useRef, useState } from "react";
import { useFocusReturn } from "./useFocusReturn";

export interface GoToLineTarget {
  /** 1-based line. */
  line: number;
  /** 1-based column. */
  column: number;
}

/** Parse IDEA's `line[:column]` input; null when invalid or out of range. */
export function parseGoToLineInput(value: string, lineCount: number): GoToLineTarget | null {
  const match = /^\s*(\d+)\s*(?:[:,]\s*(\d+)\s*)?$/.exec(value);
  if (!match) return null;
  const line = Number(match[1]);
  const column = match[2] ? Number(match[2]) : 1;
  if (!Number.isInteger(line) || line < 1 || line > Math.max(1, lineCount)) return null;
  if (!Number.isInteger(column) || column < 1) return null;
  return { line, column };
}

interface GoToLineDialogProps {
  current: GoToLineTarget;
  lineCount: number;
  onGo: (target: GoToLineTarget) => void;
  onCancel: () => void;
  restoreFocusFallback?: () => void;
}

/**
 * IDEA "Go to Line:Column" (ED-PARITY-012 DEC-012-06): prefilled with the
 * caret position and fully selected; Enter/OK jumps, Esc/Cancel moves nothing.
 */
export function GoToLineDialog({ current, lineCount, onGo, onCancel, restoreFocusFallback }: GoToLineDialogProps) {
  useFocusReturn(true, restoreFocusFallback);
  const [value, setValue] = useState(`${current.line}:${current.column}`);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const target = parseGoToLineInput(value, lineCount);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div
      className="fixed inset-0 z-[880] flex items-start justify-center pt-24"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Go to Line:Column"
        data-testid="code-workspace-goto-line-dialog"
        className="w-[320px] rounded-md border border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)] p-3 text-[12px] text-[var(--taomni-code-text)] shadow-xl"
      >
        <label className="mb-1 block text-[11px] text-[var(--taomni-code-muted)]" htmlFor="code-workspace-goto-line-input">
          [Line] [:column]:
        </label>
        <input
          id="code-workspace-goto-line-input"
          ref={inputRef}
          data-testid="code-workspace-goto-line-input"
          value={value}
          aria-invalid={!target}
          className="w-full rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-2 py-1 outline-none focus:border-[var(--taomni-accent)]"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (target) onGo(target);
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onCancel();
            }
          }}
        />
        {!target && (
          <div role="alert" data-testid="code-workspace-goto-line-error" className="mt-1 text-[11px] text-red-500">
            Enter a line between 1 and {Math.max(1, lineCount)}, optionally followed by :column
          </div>
        )}
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            data-testid="code-workspace-goto-line-ok"
            disabled={!target}
            className="rounded border border-[var(--taomni-accent)] px-3 py-0.5 disabled:opacity-40"
            onClick={() => target && onGo(target)}
          >
            OK
          </button>
          <button
            type="button"
            data-testid="code-workspace-goto-line-cancel"
            className="rounded border border-[var(--taomni-code-border)] px-3 py-0.5"
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
