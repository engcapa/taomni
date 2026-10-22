import { X } from "lucide-react";
import { useModalDraggableAndResizable } from "../../../hooks/useModalDraggableAndResizable";
import { type MailDraggableDialogProps } from "./types";


export function MailDraggableDialog({
  title,
  icon,
  ariaLabel,
  minWidth,
  minHeight,
  className,
  children,
  headerActions,
  closeTestId,
  onClose,
}: MailDraggableDialogProps) {
  const { containerRef, handleRef } = useModalDraggableAndResizable({ minWidth, minHeight });

  return (
    <div
      ref={containerRef}
      className={`relative flex flex-col rounded-md border shadow-2xl overflow-hidden ${className}`}
      style={{
        background: "var(--taomni-bg)",
        borderColor: "var(--taomni-divider)",
        color: "var(--taomni-text)",
      }}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
    >
      <div
        ref={handleRef}
        className="h-9 shrink-0 px-3 flex items-center gap-2 border-b border-[var(--taomni-divider)] bg-[var(--taomni-chrome-bg)] select-none"
      >
        {icon}
        <span className="text-[12px] font-semibold min-w-0 flex-1 truncate">
          {title}
        </span>
        {headerActions}
        <button
          type="button"
          className="taomni-btn h-6 w-6 p-0 inline-flex items-center justify-center"
          onClick={onClose}
          aria-label="Close dialog"
          title="Close"
          data-testid={closeTestId}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      {children}
    </div>
  );
}
