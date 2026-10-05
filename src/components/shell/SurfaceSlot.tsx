import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface Slots { slots: Map<string, HTMLElement>; setSlot(id: string, node: HTMLElement | null, previous?: HTMLElement | null): void }
const SurfaceContext = createContext<Slots | null>(null);
export function ShellSurfaceRegistry({ children }: { children: ReactNode }) {
  const [slots, setSlots] = useState(new Map<string, HTMLElement>());
  const setSlot = useCallback((id: string, node: HTMLElement | null, previous?: HTMLElement | null) => setSlots((old) => {
    // A new host may register before the old host unmounts during an edge move.
    if (!node && previous && old.get(id) !== previous) return old;
    if (old.get(id) === node || (!node && !old.has(id))) return old;
    const next = new Map(old); if (node) next.set(id, node); else next.delete(id); return next;
  }), []);
  return <SurfaceContext.Provider value={{ slots, setSlot }}>{children}</SurfaceContext.Provider>;
}
export function SurfaceSlot({ id, className = "h-full min-h-0 min-w-0", label }: { id: string; className?: string; label?: string }) {
  const registry = useContext(SurfaceContext);
  const previous = useRef<HTMLElement | null>(null);
  const ref = useCallback((node: HTMLDivElement | null) => { registry?.setSlot(id, node, previous.current); previous.current = node; }, [id, registry?.setSlot]);
  return <div ref={ref} data-testid="shell-surface-slot" data-slot-id={id} className={className} aria-label={label} />;
}
/** Portal target never changes. Moving its containing DOM node preserves the React tree. */
export function StableSurface({ id, slot, visible, children }: { id: string; slot: string; visible: boolean; children: ReactNode }) {
  const registry = useContext(SurfaceContext);
  const [container] = useState(() => { const node = document.createElement("div"); node.className = "h-full w-full min-h-0 min-w-0"; node.dataset.surfaceId = id; return node; });
  const target = registry?.slots.get(slot);
  useLayoutEffect(() => {
    const focused = container.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
    // Resize consumers must measure after the retained surface becomes visible.
    container.style.display = visible ? "block" : "none";
    container.inert = !visible;
    container.setAttribute("aria-hidden", String(!visible));
    if (!target) return;
    target.appendChild(container);
    if (focused && visible) focused.focus({ preventScroll: true });
    if (visible) window.dispatchEvent(new Event("resize"));
  }, [container, target, visible]);
  useLayoutEffect(() => () => container.remove(), [container]);
  return createPortal(children, container, id);
}
