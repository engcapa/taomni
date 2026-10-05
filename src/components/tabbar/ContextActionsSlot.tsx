import { useEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { useT } from "../../lib/i18n";

/** Keeps one portal host while making every contextual action reachable on small windows. */
export function ContextActionsSlot({ slotRef, hidden, owner }: { slotRef(node: HTMLDivElement | null): void; hidden: boolean; owner: string | null }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const t = useT();
  useEffect(() => setOpen(false), [owner, hidden]);
  useEffect(() => {
    if (!open) return;
    anchor.current?.querySelector<HTMLElement>('[data-testid="tab-action-slot"] button:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => { if (!anchor.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return;
      event.preventDefault(); event.stopPropagation(); setOpen(false);
      anchor.current?.querySelector<HTMLButtonElement>('[data-testid="tab-actions-more"]')?.focus();
    };
    document.addEventListener("pointerdown", outside);
    anchor.current?.addEventListener("keydown", escape);
    const current = anchor.current;
    return () => { document.removeEventListener("pointerdown", outside); current?.removeEventListener("keydown", escape); };
  }, [open]);
  return <div ref={anchor} className="shell-context-actions relative" hidden={hidden} inert={hidden} data-expanded={open}>
    <button type="button" data-testid="tab-actions-more" aria-label={t("shell.contextActions")} title={t("shell.contextActions")} aria-expanded={open} aria-controls="shell-tab-context-actions" onClick={() => setOpen(!open)} className="shell-context-actions-toggle h-8 w-8 items-center justify-center rounded hover:bg-[var(--taomni-hover)]"><MoreHorizontal className="w-4 h-4" /></button>
    <div id="shell-tab-context-actions" ref={slotRef} data-testid="tab-action-slot" className="flex items-center gap-0.5 self-stretch shrink-0 pr-1" />
  </div>;
}
