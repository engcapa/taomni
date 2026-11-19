import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useElementResizeFrame } from "../../../hooks/useElementResizeFrame";

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
      const list = event.target instanceof Element ? event.target.closest(".taomni-select-options") : null;
      const trigger = list && document.getElementById(list.getAttribute("aria-labelledby") ?? "");
      if (trigger && contentRef.current?.contains(trigger)) return;
      if (!contentRef.current?.contains(event.target) && !triggerRef.current?.contains(event.target)) close(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      if (event.target instanceof Element && contentRef.current?.contains(event.target)
        && event.target.closest('[role="combobox"][aria-expanded="true"]')) return;
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
  const update = useCallback(() => {
    const anchor = owner.triggerRef.current?.getBoundingClientRect();
    const content = owner.contentRef.current?.getBoundingClientRect();
    if (!anchor || !content) return;
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - content.width - 8));
    const above = anchor.top - content.height - 6;
    const top = Math.max(8, above >= 8 ? above : Math.min(anchor.bottom + 6, window.innerHeight - content.height - 8));
    setPosition((previous) => previous.left === left && previous.top === top ? previous : { left, top });
  }, [owner.contentRef, owner.triggerRef]);
  const schedule = useElementResizeFrame(owner.contentRef, update);
  useLayoutEffect(() => {
    if (!owner.open) return;
    update();
    window.addEventListener("scroll", schedule, true);
    return () => window.removeEventListener("scroll", schedule, true);
  }, [owner.open, update, schedule]);
  if (!owner.open) return null;
  return createPortal(<div ref={owner.contentRef} className={`tao-home-popup ${className}`} role="dialog" aria-label={label} style={{ position: "fixed", zIndex: 1000, ...position }}>{children}</div>, document.body);
}
