import { useEffect, useLayoutEffect, useRef, type ComponentProps, type PointerEvent } from "react";

interface ModalSurfaceProps extends Omit<ComponentProps<"dialog">, "onCancel" | "open"> {
  initialFocus: string;
  returnFocus?: HTMLElement | null;
  dismissOnBackdrop?: boolean;
  onCancel: () => void;
}

const focusable = 'button:enabled, input:enabled:not([type="hidden"]), textarea:enabled, select:enabled, a[href], [tabindex="0"]';
const openModalStack: HTMLDialogElement[] = [];

function isTabNavigation(event: KeyboardEvent): boolean {
  // WebKitGTK can leave the logical key unidentified for Shift+Tab.
  return !event.ctrlKey && !event.metaKey && !event.altKey
    && (event.key === "Tab" || (event.key === "Unidentified" && event.code === "Tab"));
}

function wrapModalTab(
  panel: HTMLDialogElement,
  event: Pick<KeyboardEvent, "shiftKey" | "preventDefault">,
): void {
  const controls = Array.from(panel.querySelectorAll<HTMLElement>(`:is(${focusable})`))
    .filter((control) => control.tabIndex >= 0 && !control.closest("[hidden], [inert]") && control.checkVisibility?.() !== false);
  const edge = event.shiftKey ? controls[0] : controls.at(-1);
  if (edge && document.activeElement === edge) {
    event.preventDefault();
    (event.shiftKey ? controls.at(-1) : controls[0])?.focus();
  }
}

function isOutsideDialogBox(event: PointerEvent<HTMLDialogElement>): boolean {
  if (event.target !== event.currentTarget) return false;
  const box = event.currentTarget.getBoundingClientRect();
  return event.clientX < box.left || event.clientX >= box.right || event.clientY < box.top || event.clientY >= box.bottom;
}

/** The native top layer keeps the opener's theme scope and makes the background inert. */
export function ModalSurface({
  initialFocus,
  returnFocus,
  dismissOnBackdrop = false,
  onCancel,
  onKeyDown,
  onPointerDown,
  onPointerCancel,
  onPointerUp,
  role = "dialog",
  children,
  ...props
}: ModalSurfaceProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const onCancelRef = useRef(onCancel);
  const backdropPointer = useRef<number | null>(null);
  onCancelRef.current = onCancel;

  useLayoutEffect(() => {
    const panel = ref.current!;
    const browserOpener = document.activeElement;
    const opener = returnFocus ?? browserOpener;
    openModalStack.push(panel);
    if (typeof panel.showModal === "function") panel.showModal();
    else panel.setAttribute("open", "");
    const first = panel.querySelector<HTMLElement>(initialFocus);
    first?.focus();
    if (first instanceof HTMLInputElement) first.select();
    return () => {
      const stackIndex = openModalStack.lastIndexOf(panel);
      if (stackIndex !== -1) openModalStack.splice(stackIndex, 1);
      const ownedBeforeClose = document.activeElement === document.body || panel.contains(document.activeElement);
      if (panel.open && typeof panel.close === "function") panel.close();
      const restore = (allowBrowserOpener: boolean) => {
        if (!(opener instanceof HTMLElement) || !opener.isConnected) return;
        const active = document.activeElement;
        if (
          active === document.body ||
          panel.contains(active) ||
          (allowBrowserOpener && returnFocus != null && active === browserOpener)
        ) {
          opener.focus({ preventScroll: true });
        }
      };
      restore(ownedBeforeClose);
      // A parent and its portalled confirmation can unmount in one commit.
      // Retry after both cleanups, when the child no longer owns focus.
      queueMicrotask(() => restore(ownedBeforeClose));
    };
  }, [initialFocus, returnFocus]);

  useEffect(() => {
    const handleWindowKeyDown = (event: KeyboardEvent) => {
      const panel = ref.current;
      if (!panel || event.defaultPrevented) return;
      if (event.isComposing || event.keyCode === 229) return;
      if (openModalStack.at(-1) !== panel) return;
      if (isTabNavigation(event)) {
        if (panel.contains(document.activeElement)) wrapModalTab(panel, event);
        return;
      }
      if (event.key !== "Escape") return;
      const openPopup = Array.from(
        document.querySelectorAll('[data-taomni-context-menu], [role="menu"], [role="listbox"]'),
      ).some((node) => {
        if (node === panel || node.contains(panel)) return false;
        if (node instanceof HTMLElement && (node.hidden || node.closest("[hidden]") || node.style.display === "none")) return false;
        if (node.getAttribute("role") !== "listbox") return true;
        // A visible listbox can be part of a form. Its expanded trigger identifies a popup.
        return Boolean(node.id && document.querySelector(
          `[aria-expanded="true"][aria-controls~="${CSS.escape(node.id)}"]`,
        ));
      });
      if (openPopup) return;
      const modalLayers = document.querySelectorAll(
        '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"], [data-testid="sockscap-root-prompt-dialog"]',
      );
      const lastLayer = modalLayers[modalLayers.length - 1];
      if (lastLayer && lastLayer !== panel && !lastLayer.contains(panel)) return;
      event.preventDefault();
      event.stopPropagation();
      onCancelRef.current();
    };
    window.addEventListener("keydown", handleWindowKeyDown, false);
    return () => window.removeEventListener("keydown", handleWindowKeyDown, false);
  }, []);

  return <dialog {...props} ref={ref} role={role} aria-modal="true"
    onCancel={(event) => { event.preventDefault(); onCancelRef.current(); }}
    onPointerDown={(event) => {
      backdropPointer.current = dismissOnBackdrop && event.button === 0 && isOutsideDialogBox(event) ? event.pointerId : null;
      onPointerDown?.(event);
    }}
    onPointerCancel={(event) => {
      backdropPointer.current = null;
      onPointerCancel?.(event);
    }}
    onPointerUp={(event) => {
      const dismiss = dismissOnBackdrop && backdropPointer.current === event.pointerId && isOutsideDialogBox(event);
      backdropPointer.current = null;
      onPointerUp?.(event);
      if (!event.defaultPrevented && dismiss) onCancelRef.current();
    }}
    onKeyDown={(event) => {
      event.stopPropagation();
      onKeyDown?.(event);
      if (event.defaultPrevented) return;
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
        if (event.key === "Escape") event.preventDefault();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        onCancelRef.current();
      } else if (isTabNavigation(event.nativeEvent)) {
        wrapModalTab(event.currentTarget, event);
      }
    }}>{children}</dialog>;
}
