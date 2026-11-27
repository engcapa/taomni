import { X } from "lucide-react";
import { ModalSurface } from "../../../../crates/taomni-plugin-api/frontend/ui/ModalSurface";
import { useModalDraggableAndResizable } from "../../../../../src/hooks/useModalDraggableAndResizable";
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
    <ModalSurface
      aria-label={ariaLabel}
      initialFocus='input:enabled:not([type="hidden"]), textarea:enabled, select:enabled, button:enabled'
      onCancel={onClose}
      className="m-0 max-w-full max-h-full w-screen h-screen border-0 bg-transparent p-5 open:flex items-center justify-center pointer-events-auto backdrop:bg-[var(--taomni-overlay)]"
    >
      <div
        ref={containerRef}
        className={`relative flex flex-col rounded-md border shadow-2xl overflow-hidden ${className}`}
        style={{
          background: "var(--taomni-bg)",
          borderColor: "var(--taomni-divider)",
          color: "var(--taomni-text)",
        }}
      >
        <div
          ref={handleRef}
          className="h-9 shrink-0 px-3 flex items-center gap-2 border-b border-[var(--taomni-divider)] bg-[var(--taomni-chrome-bg)] select-none"
        >
          {icon}
          <span className="text-ui-body font-semibold min-w-0 flex-1 truncate">
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
    </ModalSurface>
  );
}
