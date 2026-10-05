import { useEffect, useMemo, useRef, useState } from "react";
import { useShellLayoutStore } from "../../stores/shellLayoutStore";
import { useAppStore } from "../../stores/appStore";
import { useT } from "../../lib/i18n";
import { dispatchShellAction, type ShellAction } from "../../lib/shell/shellActions";
import { contextPanelTarget } from "../../lib/shell/contextPanel";
import { requestTabClose } from "../../lib/shell/closeCoordinator";
import type { DockEdge } from "../../lib/shell/types";
import { TAB_LANES } from "../../lib/shell/types";
import { activateShellLane } from "../../lib/shell/laneActions";

export interface ShellCommand {
  id: string; title: string; keywords?: string; disabledReason?: string;
  run(): void | Promise<unknown>;
}

export function ShellActionPalette({ commands = [] }: { commands?: ShellCommand[] }) {
  const shell = useShellLayoutStore(), app = useAppStore(), t = useT();
  const open = shell.overlay === "actions";
  const [query, setQuery] = useState(""), [index, setIndex] = useState(0), [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null), dialog = useRef<HTMLDivElement>(null);
  const pendingError = useRef<string | null>(null);
  const active = shell.laneSelection ? undefined : app.tabs.find((tab) => tab.id === app.activeTabId);
  const entries = useMemo<ShellCommand[]>(() => {
    const action = (id: ShellAction, title: string, disabledReason?: string): ShellCommand => ({ id, title, disabledReason, run: () => dispatchShellAction(id) });
    return [
      action("shell.immersive.toggle", t(shell.immersive ? "shell.exitImmersive" : "shell.immersive")),
      action("shell.home", t("shell.home")), action("shell.overview", t("shell.overview")),
      ...TAB_LANES.filter((lane) => lane !== "home").map((lane) => ({ id: `shell.lane.${lane}`, title: t(`shell.lanes.${lane}`), run: () => activateShellLane(lane) })),
      action("shell.quickSwitch", t("shell.quickSwitch")), action("shell.navigator.toggle", t("shell.navigator")),
      action("shell.panel.open", t("shell.panel"), contextPanelTarget(active, shell.panels) ? undefined : t("shell.panelUnavailable")),
      action("shell.tao.toggle", t("shell.tao")), action("shell.panels.recent", t("shell.recentPanels")),
      action("shell.layout.reset", t("shell.reset")),
      { id: "shell.rail.toggle", title: t(shell.layout.rail.visible ? "shell.hideRail" : "shell.showRail"), run: () => {
        const state = useShellLayoutStore.getState(); state.updateLayout((layout) => ({ ...layout, rail: { ...layout.rail, visible: !layout.rail.visible } })); state.flush();
      } },
      ...(["left", "top", "right", "bottom"] as DockEdge[]).map((edge): ShellCommand => ({ id: `shell.rail.${edge}`, title: `${t("shell.rail")} · ${t(`shell.${edge}`)}`, run: () => {
        const state = useShellLayoutStore.getState(); state.updateLayout((layout) => ({ ...layout, rail: { edge, visible: true } })); state.flush();
      } })),
      { id: "shell.tab.close", title: t("tabs.close"), disabledReason: active?.closable ? undefined : t("shell.actionUnavailable"), run: async () => { if (active) await requestTabClose([active.id]); } },
      ...commands,
    ];
  }, [t, shell.immersive, shell.layout.rail, shell.panels, active, commands]);
  const results = entries.filter((entry) => query.normalize("NFC").toLocaleLowerCase().trim().split(/\s+/).every((token) => `${entry.title} ${entry.id} ${entry.keywords ?? ""}`.normalize("NFC").toLocaleLowerCase().includes(token)));
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    setQuery(""); setIndex(0); setError(pendingError.current); pendingError.current = null; input.current?.focus();
    return () => {
      // Do not steal focus from a command's newly opened dialog or editor.
      if (document.activeElement !== document.body && !dialog.current?.contains(document.activeElement)) return;
      if (previous?.isConnected && !previous.closest('[inert],[hidden]') && previous.getClientRects().length) previous.focus({ preventScroll: true });
      else document.querySelector<HTMLElement>('[data-testid="shell-work-area"]')?.focus({ preventScroll: true });
    };
  }, [open]);
  useEffect(() => { if (index >= results.length) setIndex(Math.max(0, results.length - 1)); }, [index, results.length]);
  useEffect(() => { dialog.current?.querySelector(`[data-action-index="${index}"]`)?.scrollIntoView({ block: "nearest" }); }, [index]);
  if (!open) return null;
  const execute = async (command: ShellCommand | undefined) => {
    if (!command || command.disabledReason) return;
    shell.setOverlay(null);
    try { await command.run(); } catch (failure) {
      pendingError.current = String(failure);
      setError(pendingError.current);
      shell.setOverlay("actions");
    }
  };
  return <div className="fixed inset-0 z-[90] bg-black/40 flex justify-center items-start p-4 pt-12" onPointerDown={(event) => { if (event.target === event.currentTarget) shell.setOverlay(null); }}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-label={t("shell.actions")} data-testid="shell-action-palette" className="w-[680px] max-w-full max-h-[calc(100vh-80px)] flex flex-col rounded border p-3 shadow-xl" style={{ background: "var(--taomni-sidebar-bg)", color: "var(--taomni-text)" }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); shell.setOverlay(null); }
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) { event.preventDefault(); setIndex(event.key === "Home" ? 0 : event.key === "End" ? Math.max(0, results.length - 1) : Math.max(0, Math.min(results.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))); }
        if (event.key === "Enter") { event.preventDefault(); void execute(results[index]); }
        if (event.key === "Tab") { event.preventDefault(); input.current?.focus(); }
      }}>
      <label htmlFor="shell-action-search" className="text-sm mb-2">{t("shell.actions")} · F1</label>
      <input ref={input} id="shell-action-search" data-testid="shell-action-search" className="taomni-input w-full" role="combobox" aria-expanded="true" aria-controls="shell-action-results" aria-autocomplete="list" aria-activedescendant={results[index] ? `shell-action-${index}` : undefined} value={query} onChange={(event) => { setQuery(event.target.value); setIndex(0); }} />
      {error && <p role="alert">{error}</p>}
      <div id="shell-action-results" role="listbox" className="overflow-auto mt-2">
        {results.map((entry, i) => <div key={entry.id} id={`shell-action-${i}`} role="option" aria-selected={index === i} aria-disabled={!!entry.disabledReason} data-testid="shell-action-result" data-action-id={entry.id} data-action-index={i} className={`p-2 rounded cursor-pointer ${index === i ? "bg-[var(--taomni-selected)]" : ""}`} onMouseMove={() => setIndex(i)} onClick={() => void execute(entry)}>
          <div>{entry.title}</div>{entry.disabledReason && <p className="text-xs opacity-60">{entry.disabledReason}</p>}
        </div>)}
        {!results.length && <p data-testid="shell-action-empty" className="p-3">{t("shell.empty")}</p>}
      </div>
    </div>
  </div>;
}
