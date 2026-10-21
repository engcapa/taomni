import { TriangleAlert, X } from "lucide-react";
import { useEditorHostRefs } from "./useEditorHostRefs";

export interface EditorHostSurfaceProps {
  editor: ReturnType<typeof useEditorHostRefs>;
  softWrap: boolean;
  columnSelectionMode: boolean;
}

export function EditorHostSurface(props: EditorHostSurfaceProps) {
  const { editor, softWrap, columnSelectionMode } = props;
  const resolveGateUi = editor.resolveGateUi;
  return ((
    <div
      ref={editor.hostRef}
      data-soft-wrap={softWrap || undefined}
      data-column-selection={columnSelectionMode || undefined}
      className="relative h-full w-full"
      onKeyDownCapture={(event) => {
        if (event.key !== "Escape") return;
        if (resolveGateUi) {
          event.preventDefault();
          event.stopPropagation();
          resolveGateUi.dismiss();
        } else if (editor.pendingCompletionAcceptanceRef.current) {
          event.preventDefault();
          event.stopPropagation();
          editor.pendingCompletionAcceptanceRef.current();
          editor.viewRef.current?.focus();
        }
      }}
    >
      {resolveGateUi && (
        <div
          data-testid="completion-resolve-gate"
          role="alert"
          className="cm-lsp-resolve-gate absolute z-50 flex max-w-[calc(100%-16px)] flex-wrap items-center gap-2 rounded border border-amber-500/70 bg-[var(--taomni-bg-elevated,#1f2228)] px-2 py-1.5 text-xs shadow-lg"
          style={{ top: resolveGateUi.top, left: resolveGateUi.left, width: "min(460px, calc(100% - 16px))" }}
        >
          <TriangleAlert aria-hidden="true" size={14} className="shrink-0 text-amber-400" />
          <span className="min-w-0 flex-1 break-words" title={`${resolveGateUi.label} - ${resolveGateUi.message}`}>
            <strong className="font-medium">{resolveGateUi.label}</strong>
            {" - "}
            {resolveGateUi.message}
          </span>
          <button
            type="button"
            data-testid="completion-resolve-gate-retry"
            disabled={resolveGateUi.retrying}
            className="shrink-0 rounded border border-[var(--taomni-border,#3a3f4b)] px-1.5 py-0.5 hover:bg-[var(--taomni-hover,#2a2e36)] disabled:opacity-50"
            onClick={() => {
              const id = resolveGateUi.id;
              editor.setResolveGateUi((gate) => gate?.id === id ? { ...gate, retrying: true, failed: false } : gate);
              void resolveGateUi.retry().then((outcome) => {
                if (outcome === "committed") {
                  editor.setResolveGateUi((gate) => gate?.id === id ? null : gate);
                  editor.viewRef.current?.focus();
                  return;
                }
                // Retry also failed: keep the item visible with its choices.
                editor.setResolveGateUi((gate) => gate?.id === id ? { ...gate, retrying: false, failed: true } : gate);
              });
            }}
          >
            Retry
          </button>
          <button
            type="button"
            data-testid="completion-resolve-gate-insert-without-import"
            disabled={resolveGateUi.retrying}
            className="shrink-0 rounded border border-[var(--taomni-border,#3a3f4b)] px-1.5 py-0.5 hover:bg-[var(--taomni-hover,#2a2e36)] disabled:opacity-50"
            onClick={() => {
              const inserted = resolveGateUi.insertWithoutImport();
              if (inserted) {
                const id = resolveGateUi.id;
                editor.setResolveGateUi((gate) => gate?.id === id ? null : gate);
                editor.viewRef.current?.focus();
              }
            }}
          >
            Insert without import
          </button>
          <button
            type="button"
            aria-label="Dismiss"
            title="Dismiss"
            data-testid="completion-resolve-gate-dismiss"
            className="shrink-0 px-1 text-[var(--taomni-text-secondary,#9aa0aa)] hover:text-[var(--taomni-text,#e6e6e6)]"
            onClick={resolveGateUi.dismiss}
          >
            <X aria-hidden="true" size={14} />
          </button>
          {resolveGateUi.failed && (
            <span className="shrink-0 text-red-400" data-testid="completion-resolve-gate-failed-note">
              retry failed
            </span>
          )}
        </div>
      )}
    </div>
  ));
}
