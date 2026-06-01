import { Sparkles, BookOpen, Copy, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useT } from "../../lib/i18n";

interface SelectionToolbarProps {
  /// Viewport-relative bounding rect of the current selection.
  rect: { top: number; left: number; right: number; bottom: number } | null;
  /// True when there is an active selection.
  visible: boolean;
  selectionText: string;
  onSendToAi: (text: string) => void;
  onExplain: (text: string) => void;
  onCopy: (text: string) => void;
  onDismiss: () => void;
}

/**
 * Floating toolbar that appears above a terminal text selection.
 * Three actions: copy, send-to-AI (inserts as @selection in Composer),
 * explain (creates a fresh thread auto-asking for an explanation of the
 * selected output).
 *
 * Positioned absolutely in the viewport based on the selection rect; escapes
 * the terminal scroll container so it doesn't get clipped.
 */
export function SelectionToolbar({
  rect,
  visible,
  selectionText,
  onSendToAi,
  onExplain,
  onCopy,
  onDismiss,
}: SelectionToolbarProps) {
  const ref = useRef<HTMLDivElement>(null);
  const t = useT();

  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, onDismiss]);

  if (!visible || !rect) return null;

  // Place above the selection when there's room; otherwise below.
  const TOOLBAR_HEIGHT = 32;
  const PADDING = 6;
  const placeAbove = rect.top > TOOLBAR_HEIGHT + PADDING;
  const top = placeAbove ? rect.top - TOOLBAR_HEIGHT - PADDING : rect.bottom + PADDING;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - 220));

  return (
    <div
      ref={ref}
      className="fixed z-[400] flex items-center gap-1 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] px-1 py-0.5 shadow-lg"
      style={{ top, left }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="taomni-btn h-6 px-2 text-[11px] inline-flex items-center gap-1"
        title={t("terminal.selectionCopyTitle")}
        onClick={() => onCopy(selectionText)}
      >
        <Copy className="w-3 h-3" />
        {t("terminal.selectionCopy")}
      </button>
      <button
        type="button"
        className="taomni-btn h-6 px-2 text-[11px] inline-flex items-center gap-1"
        title={t("terminal.selectionSendToAiTitle")}
        onClick={() => onSendToAi(selectionText)}
      >
        <Sparkles className="w-3 h-3" />
        {t("terminal.selectionSendToAi")}
      </button>
      <button
        type="button"
        className="taomni-btn h-6 px-2 text-[11px] inline-flex items-center gap-1"
        title={t("terminal.selectionExplainTitle")}
        onClick={() => onExplain(selectionText)}
      >
        <BookOpen className="w-3 h-3" />
        {t("terminal.selectionExplain")}
      </button>
      <button
        type="button"
        className="taomni-btn h-6 w-6 p-0 inline-flex items-center justify-center"
        title={t("terminal.selectionDismissTitle")}
        onClick={onDismiss}
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  );
}
