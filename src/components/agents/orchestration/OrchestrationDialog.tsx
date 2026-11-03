import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface Props {
  testId: string;
  title: string;
  className?: string;
  onClose: () => void;
  children: ReactNode;
}

/** Focus/keyboard ownership is scoped to this dialog and restored on close. */
export function OrchestrationDialog({ testId, title, className = "", onClose, children }: Props) {
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    const element = dialog.current;
    if (!element) return;
    const focusable = () => [...element.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]',
    )].filter((node) => !node.matches(":disabled") && !node.closest("[hidden]") && ![...element.querySelectorAll("details:not([open])")].some((details) => details.contains(node) && node !== details.querySelector("summary")));
    (focusable()[0] ?? element).focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close.current();
      }
      if (event.key === "Tab") {
        const items = focusable();
        const first = items[0] ?? element;
        const last = items[items.length - 1] ?? element;
        if (event.shiftKey && (document.activeElement === first || document.activeElement === element)) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === element)) {
          event.preventDefault(); first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  return createPortal(
    <div className="orch-root orch-dialog-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) close.current();
    }}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
        data-testid={testId} className={`orch-dialog ${className}`}>
        <h2 id={titleId} className="orch-sr-only">{title}</h2>
        {children}
      </div>
    </div>, document.body,
  );
}
