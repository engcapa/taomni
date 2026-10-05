import { ToolWindowRailResizeHandle } from "../editor/workspace/panels/ToolWindowRail";
import { Home, Server, FolderTree, Sparkles, Settings, MessagesSquare, Wrench, MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { ContextMenu } from "../ContextMenu";
import { useT } from "../../lib/i18n";
import { useMainRailHostStore } from "../../stores/mainRailHostStore";
import { useToolWindowStripeStore } from "../editor/workspace/toolWindowStripeStore";
import { useShellLayoutStore } from "../../stores/shellLayoutStore";
import { useAppStore } from "../../stores/appStore";
import { tabLane } from "../../lib/shell/tabPresentation";
import { dispatchShellAction } from "../../lib/shell/shellActions";
import { useNotesStore } from "../../stores/notesStore";
import { useTaoAlertStore } from "../../stores/taoAlertStore";
import { buildTaoAlerts } from "../../lib/tao/taoAlerts";
import { activateShellLane } from "../../lib/shell/laneActions";
import type { NavigatorArea, TabLane } from "../../lib/shell/types";

export function GlobalRail({ width, hidden = false }: { width: number; hidden?: boolean }) {
  const t = useT(), shell = useShellLayoutStore();
  const notes = useNotesStore((s) => s.alerts), alerts = useTaoAlertStore();
  const alertCount = buildTaoAlerts(notes, alerts.aiDone, alerts.mailNew, alerts.transfer).length;
  const tabs = useAppStore((s) => s.tabs), activeTabId = useAppStore((s) => s.activeTabId);
  const tab = tabs.find((item) => item.id === activeTabId), lane = shell.laneSelection ?? (tab ? tabLane(tab, shell.laneOverrides[tab.id]) : "home");
  const setHost = useMainRailHostStore((s) => s.setHost);
  const stripe = useToolWindowStripeStore((s) => s.settings);
  const setWidth = useToolWindowStripeStore((s) => s.setWidth);
  const toggleNames = useToolWindowStripeStore((s) => s.toggleShowNames);
  const [menu, setMenu] = useState<{ x: number; y: number; more?: boolean } | null>(null);
  const edge = shell.layout.rail.edge, horizontal = edge === "top" || edge === "bottom";
  const buttonLayout = stripe.showNames ? "h-[48px] flex-col gap-0.5" : "h-[40px] gap-1";
  const navigate = (next: TabLane, area: NavigatorArea) => {
    if (lane === next) { shell.toggleNavigator(area, next); return; }
    activateShellLane(next);
    shell.updateLayout((layout) => ({ ...layout, navigator: { ...layout.navigator, lastArea: area, collapsedByLane: { ...layout.navigator.collapsedByLane, [next]: false } } }));
    useShellLayoutStore.setState({ navigatorOverlay: true, overlayTarget: "navigator", overlay: null });
  };
  const entries = [{ id: "home", icon: Home, onClick: () => dispatchShellAction("shell.home"), active: lane === "home" },
    { id: "sessions", icon: Server, onClick: () => navigate("connect", "sessions"), active: lane === "connect" && shell.layout.navigator.lastArea === "sessions" && !shell.layout.navigator.collapsedByLane[lane] },
    { id: "workspaces", icon: FolderTree, onClick: () => navigate("build", "workspaces"), active: lane === "build" && shell.layout.navigator.lastArea === "workspaces" && !shell.layout.navigator.collapsedByLane[lane] },
    { id: "communicate", icon: MessagesSquare, onClick: () => activateShellLane("communicate"), active: lane === "communicate", secondary: true },
    { id: "utility", icon: Wrench, onClick: () => activateShellLane("utility"), active: lane === "utility", secondary: true },
    { id: "tao", icon: Sparkles, onClick: () => dispatchShellAction("shell.tao.toggle"), active: shell.taoOpen }];
  const label = (id: string) => t(id === "communicate" || id === "utility" ? `shell.lanes.${id}` : `shell.${id}`);
  return <nav data-testid="shell-rail" data-edge={edge} data-show-names={stripe.showNames || undefined} aria-label={t("shell.rail")} className="relative flex shrink-0 border border-[var(--taomni-divider)] py-1 gap-1"
    onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setMenu({ x: event.clientX, y: event.clientY }); }}
    style={{ display: hidden ? "none" : undefined, flexDirection: horizontal ? "row" : "column", width: horizontal ? "100%" : width, height: horizontal ? (stripe.showNames ? 60 : 44) : undefined, background: "var(--taomni-tab-inactive)", color: "var(--taomni-text)" }}>
    {entries.map((entry) => <button type="button" key={entry.id} data-testid={`shell-rail-${entry.id}`} aria-label={label(entry.id)} title={entry.id === "sessions" ? t("shell.lanes.connect") : label(entry.id)}
      aria-pressed={entry.active} className={`mx-1 rounded inline-flex items-center justify-center hover:bg-[var(--taomni-hover)] aria-pressed:bg-[var(--taomni-selected)] ${entry.secondary ? "shell-rail-secondary" : ""} ${buttonLayout}`}
      onClick={entry.onClick}><entry.icon className="w-[18px] h-[18px] shrink-0" />{stripe.showNames && <span className="text-[10px] leading-3 truncate max-w-full">{label(entry.id)}</span>}{entry.id === "tao" && alertCount > 0 && <span data-testid="shell-tao-badge" className="text-[10px]">{alertCount > 99 ? "99+" : alertCount}</span>}</button>)}
    <button type="button" data-testid="shell-rail-more" aria-label={t("shell.more")} className="shell-rail-more mx-1 rounded items-center justify-center" onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setMenu({ x: rect.left, y: rect.bottom, more: true }); }}><MoreHorizontal className="w-[18px] h-[18px]" /></button>
    <div ref={setHost} data-testid="sidebar-tool-window-rail" className="flex flex-1 min-h-0 flex-col border-t border-[var(--taomni-divider)] mt-1 overflow-auto" />
    <button type="button" data-testid="shell-rail-settings" aria-label={t("shell.settings")} title={t("shell.settings")} className="mx-1 h-[40px] rounded flex items-center justify-center hover:bg-[var(--taomni-hover)]"
      onClick={() => { const app = useAppStore.getState(); const existing = app.tabs.find((t) => t.type === "settings"); if (existing) app.setActiveTab(existing.id); else app.addTab({ id: "settings", type: "settings", title: t("menu.settings"), closable: true }); }}><Settings className="w-[18px] h-[18px]" /></button>
    {stripe.showNames && !horizontal && <ToolWindowRailResizeHandle side={edge === "right" ? "right" : "left"} width={width} minWidth={68} onResize={(next) => setWidth("left", next)} testId="sidebar-rail-resize" />}
    {menu && <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={menu.more ? entries.filter((entry) => entry.secondary).map((entry) => ({ label: label(entry.id), checked: entry.active, testId: `shell-rail-more-${entry.id}`, onClick: entry.onClick })) : [
      { label: t("sidebar.showToolWindowNames"), testId: "sidebar-rail-menu-show-names", checked: stripe.showNames, onClick: toggleNames },
      ...(["left", "top", "right", "bottom"] as const).map((next) => ({ label: `${t("shell.rail")} · ${t(`shell.${next}`)}`, testId: `shell-rail-move-${next}`, checked: edge === next, onClick: () => { shell.updateLayout((layout) => ({ ...layout, rail: { edge: next, visible: true } })); shell.flush(); } })),
      { label: t("shell.hideRail"), testId: "shell-rail-hide", onClick: () => { shell.updateLayout((layout) => ({ ...layout, rail: { ...layout.rail, visible: false } })); shell.flush(); } },
    ]} />}
  </nav>;
}
