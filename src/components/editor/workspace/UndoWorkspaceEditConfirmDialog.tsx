import { useLayoutEffect, useRef, type KeyboardEvent } from "react";

interface UndoWorkspaceEditConfirmDialogProps {
  label: string | null;
  returnFocusTo: HTMLElement | null;
  onCancel: () => void;
  onConfirm: () => void;
}

export function UndoWorkspaceEditConfirmDialog({
  label,
  returnFocusTo,
  onCancel,
  onConfirm,
}: UndoWorkspaceEditConfirmDialogProps) {
  const okRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const settledRef = useRef(false);

  useLayoutEffect(() => {
    okRef.current?.focus();
    return () => {
      if (returnFocusTo?.isConnected) returnFocusTo.focus();
    };
  }, [returnFocusTo]);

  const cancel = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    onCancel();
  };
  const confirm = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    onConfirm();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      const focused = document.activeElement;
      const next = event.shiftKey
        ? focused === okRef.current ? cancelRef.current : okRef.current
        : focused === cancelRef.current ? okRef.current : cancelRef.current;
      next?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancel();
    } else if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      if (document.activeElement === cancelRef.current) cancel();
      else confirm();
    }
  };

  return (
    <div
      data-testid="code-workspace-undo-confirm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="code-workspace-undo-confirm-title"
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-4"
      onKeyDown={handleKeyDown}
    >
      <div className="w-[360px] max-w-[90vw] rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] p-4 text-[12px] text-[var(--taomni-code-text)] shadow-xl">
        <div id="code-workspace-undo-confirm-title" className="font-medium">Undo</div>
        <div className="mt-2 text-[11px] text-[var(--taomni-code-muted)]">
          Undo {label ?? "workspace edit"}?
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            data-testid="code-workspace-undo-confirm-cancel"
            className="h-7 rounded px-3 hover:bg-[var(--taomni-code-active-line-bg)]"
            onClick={cancel}
          >
            Cancel
          </button>
          <button
            ref={okRef}
            type="button"
            data-testid="code-workspace-undo-confirm-ok"
            className="h-7 rounded bg-[var(--taomni-accent)] px-3 font-medium text-white"
            onClick={confirm}
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
