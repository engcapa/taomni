import { X } from "lucide-react";
import { useId, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { ModalSurface } from "./ModalSurface";
import { IconButton } from "./IconButton";

interface ModalProps {
  title: string;
  testId: string;
  initialFocus: string;
  returnFocus?: HTMLElement | null;
  closeLabel?: string;
  size?: "default" | "wide" | "complex";
  dismissOnBackdrop?: boolean;
  onCancel: () => void;
  children: ReactNode;
  footer: ReactNode;
  role?: "dialog" | "alertdialog";
  tone?: "default" | "success" | "error";
}

// Native modal dialogs make the rest of the document inert and participate in
// the WebView's top layer, including when opened from a detached window.
export function Modal({ title, testId, initialFocus, returnFocus, closeLabel, size, dismissOnBackdrop, onCancel, children, footer, role = "dialog", tone }: ModalProps) {
  const titleId = useId();
  const bodyId = useId();
  return createPortal(
    <ModalSurface role={role} initialFocus={initialFocus} returnFocus={returnFocus} dismissOnBackdrop={dismissOnBackdrop} onCancel={onCancel}
      aria-labelledby={titleId} aria-describedby={bodyId}
      className="taomni-modal" data-testid={testId} data-tone={tone} data-size={size}>
      {closeLabel ? <header className="taomni-modal-header">
        <h2 id={titleId}>{title}</h2>
        <IconButton label={closeLabel} className="taomni-btn px-1" data-variant="ghost" onClick={onCancel}>
          <X size={14} />
        </IconButton>
      </header> : <h2 id={titleId}>{title}</h2>}
      <div id={bodyId} className="taomni-modal-body">{children}</div>
      <div className="taomni-modal-footer">{footer}</div>
    </ModalSurface>,
    document.body,
  );
}
