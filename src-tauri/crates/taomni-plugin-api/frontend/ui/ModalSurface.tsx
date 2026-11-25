import { useLayoutEffect, useRef, type ComponentProps } from "react";

interface ModalSurfaceProps extends Omit<ComponentProps<"dialog">, "onCancel" | "open"> {
  initialFocus: string;
  returnFocus?: HTMLElement | null;
  onCancel: () => void;
}

const focusable = 'button:enabled, input:enabled:not([type="hidden"]), textarea:enabled, select:enabled, a[href], [tabindex="0"]';

/** The native top layer keeps the opener's theme scope and makes the background inert. */
export function ModalSurface({ initialFocus, returnFocus, onCancel, role = "dialog", children, ...props }: ModalSurfaceProps) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const panel = ref.current!;
    const opener = returnFocus ?? document.activeElement;
    if (typeof panel.showModal === "function") panel.showModal();
    else panel.setAttribute("open", "");
    const first = panel.querySelector<HTMLElement>(initialFocus);
    first?.focus();
    if (first instanceof HTMLInputElement) first.select();
    return () => {
      if (panel.open && typeof panel.close === "function") panel.close();
      const restore = () => {
        if (opener instanceof HTMLElement && opener.isConnected &&
            (document.activeElement === document.body || panel.contains(document.activeElement))) {
          opener.focus({ preventScroll: true });
        }
      };
      restore();
      // A parent and its portalled confirmation can unmount in one commit.
      // Retry after both cleanups, when the child no longer owns focus.
      queueMicrotask(restore);
    };
  }, [initialFocus, returnFocus]);

  return <dialog {...props} ref={ref} role={role} aria-modal="true"
    onCancel={(event) => { event.preventDefault(); onCancel(); }}
    onKeyDown={(event) => {
      event.stopPropagation();
      if (event.defaultPrevented) return;
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
        if (event.key === "Escape") event.preventDefault();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      } else if (event.key === "Tab") {
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(`:is(${focusable})`))
          .filter((control) => control.tabIndex >= 0 && !control.closest("[hidden], [inert]") && control.checkVisibility?.() !== false);
        const edge = event.shiftKey ? controls[0] : controls.at(-1);
        if (edge && document.activeElement === edge) {
          event.preventDefault();
          (event.shiftKey ? controls.at(-1) : controls[0])?.focus();
        }
      }
    }}>{children}</dialog>;
}
