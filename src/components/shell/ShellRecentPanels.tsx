import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useT } from "../../lib/i18n";
import { useShellLayoutStore } from "../../stores/shellLayoutStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useAppStore } from "../../stores/appStore";
import { getPanelActions } from "../../lib/shell/panelActions";
import type { PersistedShellLayoutV2 } from "../../lib/shell/types";

export type RecentPanelEntry = PersistedShellLayoutV2["recentPanels"][number];
export type PanelOwnerSelection = { kind: "session" | "workspace"; id: string };
export type ReopenRecentPanel = (entry: RecentPanelEntry, selection: PanelOwnerSelection | undefined, signal: AbortSignal) => Promise<string>;

/** Recent metadata is independent of the primary tab list and never binds by title. */
export function ShellRecentPanels({ onOpen }: { onOpen: ReopenRecentPanel }) {
  const shell = useShellLayoutStore(), t = useT();
  const sessions = useSessionStore((s) => s.sessions), workspaces = useAppStore((s) => s.recentWorkspaces);
  const dialog = useRef<HTMLDivElement>(null), operation = useRef<AbortController | null>(null);
  const [selected, setSelected] = useState<RecentPanelEntry | null>(null);
  const [selectedOwner, setSelectedOwner] = useState<PanelOwnerSelection>();
  const [error, setError] = useState<string | null>(null), [choose, setChoose] = useState(false), [choice, setChoice] = useState("");
  const [opening, setOpening] = useState(false), [readyId, setReadyId] = useState<string | null>(null);
  const open = shell.overlay === "panels";
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    setSelected(null); setSelectedOwner(undefined); setError(null); setChoose(false); setChoice(""); setOpening(false); setReadyId(null);
    dialog.current?.querySelector<HTMLElement>("button")?.focus();
    return () => { operation.current?.abort(); operation.current = null; if (opener?.isConnected && !opener.closest("[inert]")) opener.focus(); };
  }, [open]);
  if (!open) return null;
  const close = () => shell.setOverlay(null);
  const reopen = async (entry: RecentPanelEntry, owner?: PanelOwnerSelection) => {
    if (operation.current) return;
    const controller = new AbortController(); operation.current = controller;
    setSelected(entry); setSelectedOwner(owner); setOpening(true); setError(null); setReadyId(null); setChoose(false);
    try {
      const id = await onOpen(entry, owner, controller.signal);
      if (!controller.signal.aborted) setReadyId(id);
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure instanceof Error ? failure.message : String(failure));
        setChoose((failure as { code?: string })?.code === "choose-owner"); setChoice("");
      }
    } finally { if (operation.current === controller) { operation.current = null; setOpening(false); } }
  };
  const source = selected && shell.layout.restoreSources[selected.restoreRef];
  const choices = selected?.kind === "sftp"
    ? sessions.filter((s) => ["SSH", "SFTP"].includes(s.session_type)).map((s) => ({ id: s.id, name: s.name, kind: "session" as const }))
    : workspaces.map((w) => ({ id: w.id, name: w.name, kind: "workspace" as const }));
  return <div className="fixed inset-0 z-[80] bg-black/40 flex items-start justify-center p-4 pt-12" onPointerDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-label={t("shell.recentPanels")} data-testid="shell-recent-panels"
      className="w-[640px] max-w-full max-h-[calc(100vh-96px)] flex flex-col rounded border shadow-xl"
      style={{ background: "var(--taomni-sidebar-bg)", color: "var(--taomni-text)", borderColor: "var(--taomni-divider)" }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
        if (event.key === "Tab") {
          const controls = [...(dialog.current?.querySelectorAll<HTMLElement>("button:not([disabled]),select:not([disabled])") ?? [])];
          if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
          else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
        }
      }}>
      <header className="flex items-center gap-2 p-3 border-b border-[var(--taomni-divider)]"><h2 className="flex-1 text-sm">{t("shell.recentPanels")}</h2><button data-testid="shell-recent-panels-close" aria-label={t("common.close")} onClick={close}><X className="w-4 h-4" /></button></header>
      <div className="overflow-auto p-3">
        {shell.layout.recentPanels.map((entry) => {
          const descriptor = shell.layout.restoreSources[entry.restoreRef];
          const session = descriptor?.kind === "run-entry" ? sessions.find((s) => descriptor.identity === `saved:${s.id}`) : undefined;
          const name = descriptor?.kind === "workspace" ? descriptor.workspace.name ?? descriptor.workspace.repoRoot : session?.name;
          return <button key={`${entry.restoreRef}:${entry.kind}`} data-testid="shell-recent-panel" data-restore-ref={entry.restoreRef} data-panel-kind={entry.kind} data-preferred-placement={entry.preferredPlacement}
            className="block w-full text-left p-2 rounded hover:bg-[var(--taomni-hover)] disabled:opacity-50" disabled={opening} onClick={() => void reopen(entry)}>
            <span className="block text-sm">{t(`shell.panelLabels.${entry.kind}`)} · {name ?? t("shell.missingPanelOwner")}</span>
            <span className="block text-xs opacity-70">{t(entry.preferredPlacement === "detached" ? "shell.detachedIntent" : "shell.reopenPanelOwner")}</span>
          </button>;
        })}
        {!shell.layout.recentPanels.length && <p data-testid="shell-recent-panel-empty" className="text-sm">{t("shell.noRecentPanels")}</p>}
        {opening && <p role="status" data-testid="shell-recent-panel-opening">{t("shell.openingPanel")}</p>}
        {error && <p role="alert" data-testid="shell-recent-panel-error" className="text-sm mt-3">{error}</p>}
        {choose && selected && <div data-testid="shell-recent-panel-owner-choice" className="flex flex-wrap gap-2 mt-3">
          <label className="w-full text-sm" htmlFor="shell-recent-owner">{t(selected.kind === "sftp" ? "shell.chooseConnection" : "shell.chooseWorkspace")}</label>
          <select id="shell-recent-owner" data-testid="shell-recent-panel-owner" className="taomni-input min-w-0 flex-1" value={choice} onChange={(event) => setChoice(event.target.value)}>
            <option value="">{t("shell.chooseOwner")}</option>{choices.map((owner) => <option key={owner.id} value={owner.id}>{owner.name}</option>)}
          </select>
          <button data-testid="shell-recent-panel-bind" disabled={!choice} onClick={() => { const owner = choices.find((candidate) => candidate.id === choice); if (owner) void reopen(selected, { kind: owner.kind, id: owner.id }); }}>{t("common.open")}</button>
          <button data-testid="shell-recent-panel-cancel" onClick={() => { setChoose(false); setError(null); setSelected(null); }}>{t("common.cancel")}</button>
        </div>}
        {error && !choose && selected && <button data-testid="shell-recent-panel-retry" onClick={() => void reopen(selected, selectedOwner)}>{t("shell.retry")}</button>}
        {readyId && <div className="flex gap-3 mt-3"><button data-testid="shell-recent-panel-show" onClick={close}>{t("shell.showPanel")}</button>
          {selected?.preferredPlacement === "detached" && getPanelActions(readyId)?.detach && <button data-testid="shell-recent-panel-detach" onClick={() => { close(); void getPanelActions(readyId)?.detach?.(); }}>{t("shell.detachAgain")}</button>}
        </div>}
        {source?.kind === "unsupported" && <p className="text-sm">{t("shell.unsupportedView", { kind: source.originalKind })}</p>}
      </div>
    </div>
  </div>;
}
