import { useId, useState } from "react";
import { useT } from "../../../lib/i18n";
import { Modal } from "../../ui/Modal";
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
  const t = useT();
  const errorId = useId();
  const target = parseGoToLineInput(value, lineCount);

  return <Modal title={t("goToLine.title")} testId="code-workspace-goto-line-dialog"
    initialFocus='[data-testid="code-workspace-goto-line-input"]' onCancel={onCancel} dismissOnBackdrop
    footer={<>
      <button type="button" data-testid="code-workspace-goto-line-cancel" className="taomni-btn" onClick={onCancel}>
        {t("common.cancel")}
      </button>
      <button type="button" data-testid="code-workspace-goto-line-ok" className="taomni-btn" data-primary="true"
        disabled={!target} onClick={() => target && onGo(target)}>
        {t("goToLine.jump")}
      </button>
    </>}>
    <label className="mb-1 block text-ui-small" htmlFor="code-workspace-goto-line-input">{t("goToLine.position")}</label>
    <input id="code-workspace-goto-line-input" data-testid="code-workspace-goto-line-input" className="taomni-input w-full"
      value={value} aria-invalid={!target} aria-describedby={target ? undefined : errorId}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        event.preventDefault();
        if (target) onGo(target);
      }} />
    {!target && <div id={errorId} role="alert" data-testid="code-workspace-goto-line-error" className="mt-1 text-ui-small text-ui-danger">
      {t("goToLine.range", { count: Math.max(1, lineCount) })}
    </div>}
  </Modal>;
}
