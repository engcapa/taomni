import { ContextMenu } from "../ContextMenu";
import { useState } from "react";
import { X, Pin, PinOff, MoreHorizontal } from "lucide-react";
import { useT } from "../../lib/i18n";
import { useShellLayoutStore, panelVisibility } from "../../stores/shellLayoutStore";
import { useAppStore } from "../../stores/appStore";
import { getPanelActions } from "../../lib/shell/panelActions";
import type { PanelInstance } from "../../lib/shell/types";
import { SurfaceSlot } from "./SurfaceSlot";

export function ContextPanelHost({ panels, activeId, edge }: { panels: PanelInstance[]; activeId: string; edge: "right" | "bottom" }) {
  const t = useT(), shell = useShellLayoutStore(), tabs = useAppStore((s) => s.tabs), activeTabId = useAppStore((s) => s.activeTabId);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const panel = panels.find((p) => p.id === activeId) ?? panels[0];
  if (!panel) return null;
  const ownerId = panel.owner.kind === "background" ? panel.owner.resourceKey : panel.owner.tabId;
  const actions = getPanelActions(panel.id), owner = panel.owner.kind === "background" ? ownerId : tabs.find((t) => t.id === ownerId)?.title ?? "";
  const move = (destination: "right" | "bottom") => {
    if (actions?.move) actions.move(destination);
    else { shell.patchPanel(panel.id, { placement: { kind: "dock", edge: destination }, requestedOpen: true }); shell.openPanel(panel.id); }
    setMenu(null);
  };
  return <section tabIndex={-1} data-testid="shell-host" data-edge={edge} data-panel-id={panel.id} data-owner-id={panel.owner.kind === "background" ? panel.owner.resourceKey : panel.owner.tabId}
    data-phase={panel.phase} data-effective-visibility={panelVisibility(panel, activeTabId, shell.taoOpen, shell.layout.tao.edge)} className="h-full min-h-0 min-w-0 flex flex-col border border-[var(--taomni-divider)]" style={{ background: "var(--taomni-sidebar-bg)", color: "var(--taomni-text)" }}>
    <header className="h-10 shrink-0 flex gap-1 items-center px-2 relative">
      <span data-testid="shell-host-owner" className="min-w-0 flex-1 truncate text-xs" title={owner}>{t("shell.owner", { name: owner })}</span>
      <button data-testid="shell-host-pin" aria-label={t(panel.pinned ? "shell.unpin" : "shell.pin")} aria-pressed={panel.pinned} onClick={() => shell.patchPanel(panel.id, { pinned: !panel.pinned })}>{panel.pinned ? <PinOff className="w-4 h-4" /> : <Pin className="w-4 h-4" />}</button>
      <button data-testid="shell-host-more" aria-label={t("shell.more")} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setMenu(menu ? null : { x: rect.left, y: rect.bottom }); }}><MoreHorizontal className="w-4 h-4" /></button>
      <button data-testid="shell-host-hide" aria-label={t("shell.hide")} onClick={() => { if (actions?.hide) actions.hide(); else shell.hidePanel(panel.id); }}><X className="w-4 h-4" /></button>
      {menu && <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={[
        { label: t("shell.right"), testId: "shell-panel-move-right", onClick: () => move("right") },
        { label: t("shell.bottom"), testId: "shell-panel-move-bottom", onClick: () => move("bottom") },
        ...(["promote", "detach", "reattach", "close"] as const).flatMap((action) => actions?.[action] ? [{
          label: t(action === "close" ? "shell.closePanel" : `shell.${action}`), testId: `shell-panel-${action}`, onClick: () => { void actions[action]?.(); },
        }] : []),
      ]} />}
    </header>
    <div role="tablist" className="h-8 shrink-0 flex gap-1 px-2 border-b border-[var(--taomni-divider)]">{panels.map((p) => <button key={p.id} role="tab" aria-selected={p.id === panel.id} data-testid="shell-host-tab" data-panel-id={p.id} className="px-2 text-xs" onClick={() => shell.openPanel(p.id)}>{t(`shell.panelLabels.${p.kind}`)}</button>)}</div>
    {panel.placement.kind === "detached" ? <div data-testid="shell-detached-placeholder" className="p-3 text-sm"><p>{t("shell.detached")}</p><button data-testid="shell-detached-focus" onClick={() => void actions?.focus?.()}>{t("shell.focusWindow")}</button><button data-testid="shell-panel-reattach" onClick={() => void actions?.reattach?.()}>{t("shell.reattach")}</button></div>
      : <SurfaceSlot id={`panel:${panel.id}`} className="flex-1 min-h-0 min-w-0 overflow-hidden" />}
    {panel.error && <div role="alert" className="p-2 text-xs"><span>{panel.error.message}</span><button data-testid="shell-host-retry" onClick={() => void actions?.retry?.()}>{t("shell.retry")}</button></div>}
  </section>;
}
