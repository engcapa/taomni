import { useEffect, useLayoutEffect, useState, type RefObject } from "react";

/** Anchoring, outside dismissal and keyboard focus for a title-bar popover. */
export function useToolbarPopover(open: boolean, onClose: () => void,
  anchorRef: RefObject<HTMLElement | null>, menuRef: RefObject<HTMLElement | null>) {
  const [position, setPosition] = useState({ top: 0, right: 4 });
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (rect) setPosition({ top: rect.bottom + 4, right: Math.max(4, innerWidth - rect.right) });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, anchorRef]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target || anchorRef.current?.contains(target) || menuRef.current?.contains(target)
        || target.closest("[data-taomni-context-menu]")) return;
      onClose();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
      anchorRef.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    };
    document.addEventListener("mousedown", outside);
    window.addEventListener("keydown", keydown, true);
    return () => {
      document.removeEventListener("mousedown", outside);
      window.removeEventListener("keydown", keydown, true);
    };
  }, [open, onClose, anchorRef, menuRef]);
  return position;
}
