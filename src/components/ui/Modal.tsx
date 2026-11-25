import { useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

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
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const bodyId = useId();
  useLayoutEffect(() => {
    const panel = ref.current!;
    const opener = document.activeElement;
    if (typeof panel.showModal === "function") panel.showModal();
    else panel.setAttribute("open", ""); // DOM implementations without modal support
    const first = panel.querySelector<HTMLElement>(initialFocus);
    first?.focus();
    if (first instanceof HTMLInputElement) first.select();
    return () => {
      if (panel.open && typeof panel.close === "function") panel.close();
      if (opener instanceof HTMLElement && opener.isConnected && (document.activeElement === document.body || panel.contains(document.activeElement))) {
        opener.focus({ preventScroll: true });
      }
    };
  }, [initialFocus]);

  return createPortal(
    <dialog ref={ref} role={role} aria-modal="true" aria-labelledby={titleId} aria-describedby={bodyId}
      className="taomni-modal" data-testid={testId} data-tone={tone}
      onCancel={(event) => { event.preventDefault(); onCancel(); }}
      onKeyDown={(event) => {
        if (event.key !== "Tab" && event.key !== "Escape" && event.key !== "Enter") return;
        event.stopPropagation();
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
          if (event.key === "Escape") event.preventDefault();
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        } else if (event.key === "Tab") {
          const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
            'button:enabled, input:enabled, textarea:enabled, select:enabled, a[href], [tabindex="0"]',
          )).filter((control) => !control.closest("[hidden], [inert]"));
          const edge = event.shiftKey ? controls[0] : controls.at(-1);
          if (edge && document.activeElement === edge) {
            event.preventDefault();
            (event.shiftKey ? controls.at(-1) : controls[0])?.focus();
          }
        }
      }}>
      <h2 id={titleId}>{title}</h2>
      <div id={bodyId} className="taomni-modal-body">{children}</div>
      <div className="taomni-modal-footer">{footer}</div>
    </dialog>,
    document.body,
  );
}
