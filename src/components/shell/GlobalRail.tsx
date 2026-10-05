import { ToolWindowRailResizeHandle } from "../editor/workspace/panels/ToolWindowRail";
import { Home, Server, FolderTree, Sparkles, Settings } from "lucide-react";
import { useState } from "react";
import { ContextMenu } from "../ContextMenu";
import { useT } from "../../lib/i18n";
import { useMainRailHostStore } from "../../stores/mainRailHostStore";
import { useToolWindowStripeStore } from "../editor/workspace/toolWindowStripeStore";
import { useShellLayoutStore } from "../../stores/shellLayoutStore";
import { useAppStore } from "../../stores/appStore";
import { tabLane } from "../../lib/shell/tabPresentation";
import { dispatchShellAction } from "../../lib/shell/shellActions";

export function GlobalRail({ width }: { width: number }) {
  const t = useT(), shell = useShellLayoutStore();
  const tabs = useAppStore((s) => s.tabs), activeTabId = useAppStore((s) => s.activeTabId);
  const tab = tabs.find((item) => item.id === activeTabId), lane = shell.laneSelection ?? (tab ? tabLane(tab, shell.laneOverrides[tab.id]) : "home");
  const setHost = useMainRailHostStore((s) => s.setHost);
  const stripe = useToolWindowStripeStore((s) => s.settings);
  const setWidth = useToolWindowStripeStore((s) => s.setWidth);
  const toggleNames = useToolWindowStripeStore((s) => s.toggleShowNames);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const buttonLayout = stripe.showNames ? "h-[48px] flex-col gap-0.5" : "h-[40px] gap-1";
  const entries = [{ id: "home", icon: Home, onClick: () => dispatchShellAction("shell.home"), active: lane === "home" },
    { id: "sessions", icon: Server, onClick: () => shell.toggleNavigator("sessions", lane), active: shell.layout.navigator.lastArea === "sessions" && !shell.layout.navigator.collapsedByLane[lane] },
    { id: "workspaces", icon: FolderTree, onClick: () => shell.toggleNavigator("workspaces", lane), active: shell.layout.navigator.lastArea === "workspaces" && !shell.layout.navigator.collapsedByLane[lane] },
    { id: "tao", icon: Sparkles, onClick: () => dispatchShellAction("shell.tao.toggle"), active: shell.taoOpen }];
  return <nav data-testid="shell-rail" aria-label={t("shell.navigator")} className="relative flex shrink-0 flex-col border-r border-[var(--taomni-divider)] py-1 gap-1"
    onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setMenu({ x: event.clientX, y: event.clientY }); }}
    style={{ width, background: "var(--taomni-tab-inactive)", color: "var(--taomni-text)" }}>
    {entries.map((entry) => <button type="button" key={entry.id} data-testid={`shell-rail-${entry.id}`} aria-label={t(`shell.${entry.id}`)} title={t(`shell.${entry.id}`)}
      aria-pressed={entry.active} className={`mx-1 rounded inline-flex items-center justify-center hover:bg-[var(--taomni-hover)] aria-pressed:bg-[var(--taomni-selected)] ${buttonLayout}`}
      onClick={entry.onClick}><entry.icon className="w-[18px] h-[18px] shrink-0" />{stripe.showNames && <span className="text-[10px] leading-3 whitespace-nowrap">{t(`shell.${entry.id}`)}</span>}</button>)}
    <div ref={setHost} data-testid="sidebar-tool-window-rail" className="flex flex-1 min-h-0 flex-col border-t border-[var(--taomni-divider)] mt-1 overflow-auto" />
    <button type="button" data-testid="shell-rail-settings" aria-label={t("shell.settings")} title={t("shell.settings")} className="mx-1 h-[40px] rounded flex items-center justify-center hover:bg-[var(--taomni-hover)]"
      onClick={() => { const app = useAppStore.getState(); const existing = app.tabs.find((t) => t.type === "settings"); if (existing) app.setActiveTab(existing.id); else app.addTab({ id: "settings", type: "settings", title: t("menu.settings"), closable: true }); }}><Settings className="w-[18px] h-[18px]" /></button>
    {stripe.showNames && <ToolWindowRailResizeHandle side="left" width={width} minWidth={68} onResize={(next) => setWidth("left", next)} testId="sidebar-rail-resize" />}
    {menu && <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={[{ label: t("sidebar.showToolWindowNames"), testId: "sidebar-rail-menu-show-names", checked: stripe.showNames, onClick: toggleNames }]} />}
  </nav>;
}
