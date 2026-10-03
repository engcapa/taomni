import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { EditorView } from "@codemirror/view";

export interface CodeInsightNoticeState {
  /** Bumps on every show so a repeated notice re-anchors. */
  id: number;
  message: string;
  action: "configure" | null;
  anchor: { left: number; top: number; bottom: number };
}

/**
 * Caret rect of the focused (or given) editor, viewport-relative. Falls back
 * to the top-left of `fallback` when no editor view is reachable.
 */
export function caretAnchor(fallback: HTMLElement | null): CodeInsightNoticeState["anchor"] {
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const content = active?.closest<HTMLElement>(".cm-content")
    ?? fallback?.querySelector<HTMLElement>(".cm-editor.cm-focused .cm-content")
    ?? fallback?.querySelector<HTMLElement>(".cm-content")
    ?? null;
  const view = content ? EditorView.findFromDOM(content) : null;
  const coords = view?.coordsAtPos(view.state.selection.main.head) ?? null;
  if (coords) return { left: coords.left, top: coords.top, bottom: coords.bottom };
  const rect = fallback?.getBoundingClientRect();
  const left = (rect?.left ?? 0) + 80;
  const top = (rect?.top ?? 0) + 80;
  return { left, top, bottom: top + 16 };
}

interface CodeInsightNoticeProps {
  notice: CodeInsightNoticeState;
  onClose: () => void;
  onConfigure?: () => void;
}

/**
 * ED-PARITY-020 DEC-020-01: IDEA answers Quick Doc / Parameter Info / Alt+Enter
 * / member completion with a small popup at the caret even when there is
 * nothing to show ("No documentation found.", an unavailable service). The
 * popup never takes focus: the next key closes it (Esc is consumed), so the
 * editor keeps its caret and selection.
 */
export function CodeInsightNotice({ notice, onClose, onConfigure }: CodeInsightNoticeProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [position, setPosition] = useState({ left: notice.anchor.left, top: notice.anchor.bottom + 4 });

  useLayoutEffect(() => {
    const element = ref.current;
    const height = element?.offsetHeight ?? 24;
    const width = element?.offsetWidth ?? 240;
    const below = notice.anchor.bottom + 4;
    // Below the caret line first (IDEA); flip above when the viewport ends.
    const top = below + height > window.innerHeight - 4 ? Math.max(4, notice.anchor.top - height - 4) : below;
    const left = Math.max(4, Math.min(notice.anchor.left, window.innerWidth - width - 4));
    setPosition({ left, top });
  }, [notice]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (["Shift", "Control", "Alt", "Meta"].includes(event.key) || event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
      }
      onCloseRef.current();
    };
    const onPointerDown = (event: MouseEvent) => {
      if (event.target instanceof Node && ref.current?.contains(event.target)) return;
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("mousedown", onPointerDown, true);
    window.addEventListener("wheel", onPointerDown as EventListener, { capture: true, passive: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("mousedown", onPointerDown, true);
      window.removeEventListener("wheel", onPointerDown as EventListener, true);
    };
  }, [notice.id]);

  return (
    <div
      ref={ref}
      role="status"
      data-testid="code-workspace-code-insight-notice"
      className="fixed z-[860] max-w-[420px] rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)] px-2 py-1 text-[12px] text-[var(--taomni-code-text)] shadow-lg flex items-center gap-2"
      style={{ left: position.left, top: position.top }}
    >
      <span className="min-w-0 break-words">{notice.message}</span>
      {notice.action === "configure" && onConfigure && (
        <button
          type="button"
          data-testid="code-workspace-code-insight-configure"
          className="shrink-0 text-[var(--taomni-accent)] underline decoration-dotted underline-offset-2"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            onConfigure();
            onClose();
          }}
        >
          Configure…
        </button>
      )}
    </div>
  );
}
