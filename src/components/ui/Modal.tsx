import { useId, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { ModalSurface } from "./ModalSurface";

interface ModalProps {
  title: string;
  testId: string;
  initialFocus: string;
  onCancel: () => void;
  children: ReactNode;
  footer: ReactNode;
  role?: "dialog" | "alertdialog";
  tone?: "default" | "success" | "error";
}

// Native modal dialogs make the rest of the document inert and participate in
// the WebView's top layer, including when opened from a detached window.
export function Modal({ title, testId, initialFocus, onCancel, children, footer, role = "dialog", tone }: ModalProps) {
  const titleId = useId();
  const bodyId = useId();
  return createPortal(
    <ModalSurface role={role} initialFocus={initialFocus} onCancel={onCancel}
      aria-labelledby={titleId} aria-describedby={bodyId}
      className="taomni-modal" data-testid={testId} data-tone={tone}>
      <h2 id={titleId}>{title}</h2>
      <div id={bodyId} className="taomni-modal-body">{children}</div>
      <div className="taomni-modal-footer">{footer}</div>
    </ModalSurface>,
    document.body,
  );
}
