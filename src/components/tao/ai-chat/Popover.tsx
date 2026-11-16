import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** One popup owner, rendered outside scrolling/clipping surfaces. */
export function useTaoPopover() {
  const id = useId();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const close = (restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    window.dispatchEvent(new CustomEvent("tao:popover-open", { detail: id }));
    const otherOpened = (event: Event) => { if ((event as CustomEvent<string>).detail !== id) setOpen(false); };
    const pointer = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (!contentRef.current?.contains(event.target) && !triggerRef.current?.contains(event.target)) close(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      // An inner confirmation owns Escape until it is dismissed.
      if (contentRef.current?.querySelector('[aria-modal="true"]')) return;
      event.preventDefault(); event.stopPropagation(); close();
    };
    window.addEventListener("tao:popover-open", otherOpened);
    window.addEventListener("pointerdown", pointer, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("tao:popover-open", otherOpened);
      window.removeEventListener("pointerdown", pointer, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [open, id]);
  return { open, setOpen, close, triggerRef, contentRef };
}

export function TaoPopover({ owner, children, className = "", label }: { owner: ReturnType<typeof useTaoPopover>; children: ReactNode; className?: string; label: string }) {
  const [position, setPosition] = useState({ left: 12, top: 12 });
  useLayoutEffect(() => {
    if (!owner.open) return;
    const update = () => {
      const anchor = owner.triggerRef.current?.getBoundingClientRect();
      const content = owner.contentRef.current?.getBoundingClientRect();
      if (!anchor || !content) return;
      const left = Math.max(8, Math.min(anchor.left, window.innerWidth - content.width - 8));
      const above = anchor.top - content.height - 6;
      setPosition({ left, top: Math.max(8, above >= 8 ? above : Math.min(anchor.bottom + 6, window.innerHeight - content.height - 8)) });
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    if (owner.contentRef.current) observer?.observe(owner.contentRef.current);
    window.addEventListener("resize", update); window.addEventListener("scroll", update, true);
    return () => { observer?.disconnect(); window.removeEventListener("resize", update); window.removeEventListener("scroll", update, true); };
  }, [owner.open, owner.contentRef, owner.triggerRef]);
  if (!owner.open) return null;
  return createPortal(<div ref={owner.contentRef} className={`tao-home-popup ${className}`} role="dialog" aria-label={label} style={{ position: "fixed", zIndex: 1000, ...position }}>{children}</div>, document.body);
}
