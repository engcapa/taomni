import { useEffect, useRef } from "react";
import { Pin, X } from "lucide-react";
import { renderFormatted } from "../../../lib/chat/renderFormatted";

export interface QuickDocContent {
  /** Symbol or path label shown in the header. */
  title: string;
  /** Markdown / plaintext body from LSP hover. */
  body: string;
}

interface QuickDocPopupProps {
  open: boolean;
  content: QuickDocContent | null;
  onClose: () => void;
  onPin: (content: QuickDocContent) => void;
}

export function QuickDocPopup({ open, content, onClose, onPin }: QuickDocPopupProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, open]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      const root = rootRef.current;
      if (!root) return;
      if (event.target instanceof Node && !root.contains(event.target)) {
        onClose();
      }
    };
    window.addEventListener("mousedown", onPointer, true);
    return () => window.removeEventListener("mousedown", onPointer, true);
  }, [onClose, open]);

  if (!open || !content) return null;

  const html = renderFormatted(content.body, "md") ?? content.body;

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label="Quick documentation"
      data-testid="code-workspace-quick-doc"
      className="absolute right-6 top-16 z-40 flex max-h-[min(420px,60vh)] w-[min(420px,90vw)] flex-col overflow-hidden rounded-md border border-[var(--taomni-code-border)] bg-[var(--taomni-code-tooltip-bg)] shadow-xl"
    >
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-[var(--taomni-code-border)] px-2">
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-[var(--taomni-code-text)]">
          {content.title}
        </span>
        <button
          type="button"
          title="Pin to Documentation pane"
          aria-label="Pin to Documentation pane"
          data-testid="code-workspace-quick-doc-pin"
          className="inline-flex h-6 w-6 items-center justify-center rounded text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)] hover:text-[var(--taomni-code-text)]"
          onClick={() => onPin(content)}
        >
          <Pin className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          title="Close"
          aria-label="Close quick documentation"
          className="inline-flex h-6 w-6 items-center justify-center rounded text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)] hover:text-[var(--taomni-code-text)]"
          onClick={onClose}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div
        className="taomni-chat-md min-h-0 flex-1 overflow-auto px-3 py-2 text-[12px] leading-relaxed text-[var(--taomni-code-text)]"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
