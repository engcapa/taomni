import { ChevronDown, Search } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAppStore } from "../../stores/appStore";
import { useT } from "../../lib/i18n";
import { tabSearchText } from "../../lib/tabFilter";

/** All live Sessions terminals remain selectable, including filtered/overflow tabs. */
export function MultiExecTargets({ selectedCount, totalCount }: { selectedCount: number; totalCount: number }) {
  const t = useT();
  const tabs = useAppStore((state) => state.tabs);
  const selected = useAppStore((state) => state.multiExecSelectedTabIds);
  const split = useAppStore((state) => state.terminalSplitActive);
  const locked = useAppStore((state) => state.terminalSplitInputLockedTabIds);
  const toggle = useAppStore((state) => state.toggleMultiExecTab);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState({ top: 0, right: 8 });
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const rect = button.current?.getBoundingClientRect();
      if (rect) setPosition({ top: rect.bottom + 4, right: Math.max(8, window.innerWidth - rect.right) });
    };
    update();
    input.current?.focus();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const matches = tabs.filter((tab) => tab.type === "terminal" && tabSearchText(tab).includes(query.trim().toLowerCase()));
  return <>
    <button ref={button} type="button" data-testid="multiexec-targets" className="taomni-pill inline-flex shrink-0 items-center gap-1 text-[11px]"
      title={t("multiExec.targets")} aria-label={t("multiExec.targets")} aria-haspopup="dialog" aria-expanded={open}
      onClick={() => { setQuery(""); setOpen((value) => !value); }}>
      {selectedCount} / {totalCount}<ChevronDown className="h-3 w-3" />
    </button>
    {open && createPortal(<div ref={menu} data-testid="multiexec-target-menu" role="dialog" aria-label={t("multiExec.targets")}
      className="fixed z-[9999] flex max-h-[60vh] w-80 max-w-[95vw] flex-col rounded-md border p-2 text-xs shadow-lg"
      style={{ ...position, background: "var(--taomni-panel-bg)", borderColor: "var(--taomni-divider)", color: "var(--taomni-text)" }}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); button.current?.focus(); }
      }}>
      <strong className="mb-2">{t("multiExec.targets")}</strong>
      <label className="mb-2 flex items-center gap-2"><Search className="h-3 w-3" />
        <input ref={input} data-testid="multiexec-target-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)}
          className="taomni-input min-w-0 flex-1" aria-label={t("tabs.filterPlaceholder")} placeholder={t("tabs.filterPlaceholder")} />
      </label>
      <div className="min-h-0 overflow-y-auto">
        {matches.map((tab) => <label key={tab.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-2 hover:bg-[var(--taomni-hover)]">
          <input type="checkbox" data-testid="multiexec-target-checkbox" data-tab-id={tab.id} data-tab-title={tab.title}
            className="taomni-checkbox shrink-0" checked={selected.has(tab.id)} disabled={split && locked.has(tab.id)} onChange={() => toggle(tab.id)} />
          <span className="min-w-0 flex-1 truncate" title={tab.title}>{tab.title}</span>
          {split && locked.has(tab.id) && <span className="text-[var(--taomni-text-muted)]">{t("multiExec.inputLocked")}</span>}
        </label>)}
        {!matches.length && <p data-testid="multiexec-target-empty" className="p-2 text-[var(--taomni-text-muted)]">{t("tabs.filterNoMatch")}</p>}
      </div>
    </div>, document.body)}
  </>;
}
