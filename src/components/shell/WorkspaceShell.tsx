import { Component, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useT } from "../../lib/i18n";
import { useShellLayoutStore, panelVisibility } from "../../stores/shellLayoutStore";
import { useAppStore } from "../../stores/appStore";
import { useShellLayoutBridge } from "../../hooks/useShellLayoutBridge";
import { useShellCloseBridge } from "../../hooks/useShellCloseBridge";
import { useShellShortcuts } from "../../hooks/useShellShortcuts";
import { solveShellLayout } from "../../lib/shell/layoutPolicy";
import { tabLane } from "../../lib/shell/tabPresentation";
import { GlobalRail } from "./GlobalRail";
import { ShellSurfaceRegistry, StableSurface, SurfaceSlot } from "./SurfaceSlot";
import { ContextPanelHost } from "./ContextPanelHost";
import { ShellRecentPanels, type ReopenRecentPanel } from "./ShellRecentPanels";
import { TabNavigator } from "./TabNavigator";
import { ShellTransfers } from "./ShellTransfers";
import "./shell.css";
import { installGitPanelWindowReceiver } from "../../lib/shell/gitPanelWindow";
import { installSftpPanelWindowReceiver } from "../../lib/shell/sftpPanelWindow";
import { installNotesPanelWindowReceiver } from "../../lib/shell/notesPanelWindow";
import { t as translate } from "../../lib/i18n";
import { useToolWindowStripeStore } from "../editor/workspace/toolWindowStripeStore";
import { effectiveStripeWidth } from "../editor/workspace/toolWindowLayout";
import { ShellActionPalette, type ShellCommand } from "./ShellActionPalette";
import { dispatchShellAction } from "../../lib/shell/shellActions";

export class ShellBoundary extends Component<{ children: ReactNode; workArea?: boolean }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <ShellFallback workArea={this.props.workArea} reset={() => { useShellLayoutStore.getState().resetLayout(); this.setState({ failed: false }); }} /> : this.props.children; }
}
function ShellFallback({ workArea, reset }: { workArea?: boolean; reset(): void }) {
  const tabs = useAppStore((state) => state.tabs), activeId = useAppStore((state) => state.activeTabId);
  return <div data-testid="shell-fallback" className="flex-1 flex flex-col min-h-0 min-w-0">
    <div role="alert" className="p-3 border rounded flex gap-3 flex-wrap items-center">
      <p>{translate("shell.fallback")}</p>
      <button data-testid="shell-fallback-home" onClick={() => { useShellLayoutStore.getState().selectLane(null); useAppStore.getState().setActiveTab("welcome"); }}>{translate("shell.home")}</button>
      <button data-testid="shell-fallback-actions" onClick={() => dispatchShellAction("shell.actions")}>{translate("shell.actions")}</button>
      <button data-testid="shell-fallback-reset" onClick={reset}>{translate("shell.reset")}</button>
      <button data-testid="shell-fallback-reload" onClick={() => location.reload()}>{translate("shell.reload")}</button>
      {tabs.filter((tab) => tab.type !== "welcome").map((tab) => <button key={tab.id} data-testid="shell-fallback-tab" data-tab-id={tab.id} aria-pressed={tab.id === activeId} onClick={() => { useShellLayoutStore.getState().selectLane(null); useAppStore.getState().setActiveTab(tab.id); }}>{tab.title}</button>)}
    </div>
    {workArea && <div data-testid="shell-work-area" tabIndex={-1} className="flex-1 min-h-0"><SurfaceSlot id="shell-business" /></div>}
  </div>;
}
export function WorkspaceShell({ children, onNewSession, onReopenPanel, commands }: { children: ReactNode; onNewSession(): void; onReopenPanel: ReopenRecentPanel; commands?: ShellCommand[] }) {
  useShellLayoutBridge();
  useShellShortcuts();
  useEffect(installGitPanelWindowReceiver, []);
  useEffect(installSftpPanelWindowReceiver, []);
  useEffect(installNotesPanelWindowReceiver, []);
  const closeDialog = useShellCloseBridge();
  return <ShellSurfaceRegistry>{children}<ShellBoundary><TabNavigator onNewSession={onNewSession} /><ShellRecentPanels onOpen={onReopenPanel} /></ShellBoundary><ShellActionPalette commands={commands} /><ShellTransfers />{closeDialog}</ShellSurfaceRegistry>;
}
function useViewport() {
  const [size, setSize] = useState({ width: window.innerWidth, height: window.innerHeight });
  useEffect(() => { const resize = () => setSize({ width: window.innerWidth, height: window.innerHeight }); window.addEventListener("resize", resize); return () => window.removeEventListener("resize", resize); }, []);
  return size;
}
interface ShellFrameProps { children: ReactNode; navigator: ReactNode; quickConnectHeight?: number; extras?: ReactNode; onCreateLane?(lane: string): void }
export function ShellFrame({ children, ...chrome }: ShellFrameProps) {
  const laneSelection = useShellLayoutStore((state) => state.laneSelection);
  // The business tree is a sibling of the chrome boundary. Both the normal
  // frame and fallback adopt the same DOM node, preserving controllers/PTYs.
  // Hide the persistent container itself for empty categories so descendant
  // controls and composited sticky content cannot paint over the empty state.
  return <><StableSurface id="shell-business" slot="shell-business" visible={!laneSelection}>{children}</StableSurface>
    <ShellBoundary workArea><ShellFrameChrome {...chrome}><SurfaceSlot id="shell-business" /></ShellFrameChrome></ShellBoundary></>;
}
function ShellFrameChrome({ children, navigator, quickConnectHeight = 0, extras, onCreateLane }: ShellFrameProps) {
  const shell = useShellLayoutStore(), activeTabId = useAppStore((s) => s.activeTabId), tabs = useAppStore((s) => s.tabs), size = useViewport(), t = useT();
  const [preview, setPreview] = useState<Partial<Record<"navigator" | "right" | "bottom", number>>>({});
  const stripe = useToolWindowStripeStore((s) => s.settings);
  const railWidth = stripe.showNames ? Math.max(68, effectiveStripeWidth(stripe, "left")) : 52;
  const railEdge = shell.layout.rail.edge, horizontalRail = railEdge === "top" || railEdge === "bottom";
  const railVisible = shell.layout.rail.visible && !shell.immersive;
  const active = tabs.find((tab) => tab.id === activeTabId), lane = shell.laneSelection ?? (active ? tabLane(active, shell.laneOverrides[active.id]) : "home");
  // Hidden tools still own their surface. Keep them reachable in the current
  // owner's Host tabs while another tool on that edge is displayed.
  const panels = Object.values(shell.panels).filter((p) => !shell.laneSelection && panelVisibility(p, activeTabId, shell.taoOpen, shell.layout.tao.edge) !== "inactive-owner" && p.placement.kind !== "primary");
  const at = (edge: "right" | "bottom") => panels.filter((p) => p.placement.kind === "dock" ? p.placement.edge === edge : edge === "right");
  const right = at("right"), bottom = at("bottom");
  const displayed = (panel: typeof panels[number]) => ["visible", "detached-placeholder"].includes(panelVisibility(panel, activeTabId, shell.taoOpen, shell.layout.tao.edge));
  const rightPanel = right.find((p) => p.id === shell.activePanelByEdge.right && displayed(p)) ?? right.find(displayed);
  const bottomPanel = bottom.find((p) => p.id === shell.activePanelByEdge.bottom && displayed(p)) ?? bottom.find(displayed);
  const layout = solveShellLayout({ ...size, height: size.height - (railVisible && horizontalRail ? (stripe.showNames ? 60 : 44) : 0), railWidth: railVisible && !horizontalRail ? railWidth : 0, quickConnectHeight, navigatorRequested: !shell.layout.navigator.collapsedByLane[lane], navigatorWidth: preview.navigator ?? shell.layout.navigator.width,
    navigatorExplicit: shell.navigatorOverlay,
    rightRequested: !!rightPanel, rightSize: preview.right ?? rightPanel?.preferredSize ?? shell.layout.panelDefaults[rightPanel?.kind ?? "sftp"].size,
    bottomRequested: !!bottomPanel, bottomSize: preview.bottom ?? bottomPanel?.preferredSize ?? shell.layout.panelDefaults[bottomPanel?.kind ?? "git"].size,
    taoOpen: shell.taoOpen, taoEdge: shell.layout.tao.edge, taoPinned: shell.layout.tao.pinned, taoWidth: shell.layout.tao.width, taoHeight: shell.layout.tao.height });
  if (rightPanel && !rightPanel.pinned && layout.right === "dock") layout.right = "overlay";
  if (bottomPanel && !bottomPanel.pinned && layout.bottom === "dock") layout.bottom = "overlay";
  if (shell.immersive) {
    layout.navigator = shell.immersiveReveal === "navigator" ? "overlay" : "hidden";
    layout.right = shell.immersiveReveal === "panel" && rightPanel ? "overlay" : "hidden";
    layout.bottom = shell.immersiveReveal === "panel" && bottomPanel ? "overlay" : "hidden";
    layout.tao = shell.immersiveReveal === "tao" && shell.taoOpen ? "overlay" : "hidden";
  }
  const candidates = [layout.tao === "overlay" ? "tao" : null, layout.right === "overlay" ? rightPanel?.id : null, layout.bottom === "overlay" ? bottomPanel?.id : null,
    layout.navigator === "overlay" && shell.navigatorOverlay ? "navigator" : null].filter((id): id is string => !!id);
  const winner = shell.overlay ? null : candidates.includes(shell.overlayTarget ?? "") ? shell.overlayTarget : candidates[0] ?? null;
  if (layout.tao === "overlay" && winner !== "tao") layout.tao = "hidden";
  if (layout.right === "overlay" && winner !== rightPanel?.id) layout.right = "hidden";
  if (layout.bottom === "overlay" && winner !== bottomPanel?.id) layout.bottom = "hidden";
  if (layout.navigator === "overlay" && winner !== "navigator") layout.navigator = "hidden";
  const frameRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!winner) return;
    const node = frameRef.current?.querySelector<HTMLElement>('[data-shell-overlay="true"]');
    const opener = document.activeElement as HTMLElement | null;
    const controls = () => [...(node?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),textarea,select,[tabindex="0"]') ?? [])].filter((el) => el.getBoundingClientRect().width > 0 && !el.closest('[inert]'));
    controls()[0]?.focus();
    const dismiss = () => { const s = useShellLayoutStore.getState(); if (s.immersive) { useShellLayoutStore.setState({ immersiveReveal: null, navigatorOverlay: false, overlayTarget: null }); return; } if (winner === "tao") s.setTaoOpen(false); else if (winner === "navigator") useShellLayoutStore.setState({ navigatorOverlay: false, overlayTarget: null }); else s.hidePanel(winner); };
    const key = (event: KeyboardEvent) => {
      if (event.isComposing || event.defaultPrevented || !node?.contains(event.target as Node) || document.querySelector('[data-testid="context-menu"]')) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismiss(); }
      if (event.key === "Tab") { const list = controls(), first = list[0], last = list.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } }
    };
    node?.addEventListener("keydown", key);
    const outside = (event: PointerEvent) => {
      const toggle = event.target instanceof Element && event.target.closest('[data-testid="shell-tao-toggle"],[data-testid="shell-rail-tao"],[data-testid="shell-navigator-toggle"],[data-testid="shell-rail-sessions"],[data-testid="shell-rail-workspaces"]');
      if (!toggle && node && !node.contains(event.target as Node) && !document.querySelector('[data-testid="context-menu"],[data-modal="true"]')) dismiss();
    };
    const observer = new MutationObserver(() => { if (document.activeElement === opener || document.activeElement === document.body) controls()[0]?.focus(); });
    if (node) observer.observe(node, { childList: true, subtree: true });
    document.addEventListener("pointerdown", outside);
    return () => { observer.disconnect(); document.removeEventListener("pointerdown", outside); node?.removeEventListener("keydown", key); if (opener?.isConnected && !opener.closest('[inert]')) opener.focus({ preventScroll: true }); };
  }, [winner, lane, shell.layout.tao.edge, layout.right, layout.bottom]);
  const taoSide = shell.layout.tao.edge === "left" || shell.layout.tao.edge === "right";
  const overlay = shell.overlay || shell.transfersOpen || (layout.tao === "overlay" && shell.taoOpen) || layout.right === "overlay" || layout.bottom === "overlay" || (layout.navigator === "overlay" && shell.navigatorOverlay);
  const frame = (mode: "hidden" | "dock" | "overlay", edge: string, width?: number, height?: number): React.CSSProperties => mode === "hidden" ? { display: "none" } : mode === "dock" ? { position: "relative", width, height, flexShrink: 0 }
    : { position: "absolute", zIndex: 20, top: edge === "bottom" ? undefined : 0, bottom: edge === "top" ? undefined : 0,
      left: edge === "right" ? undefined : 0, right: edge === "left" ? undefined : 0, width, height, maxWidth: "calc(100% - 8px)", maxHeight: "100%" };
  const taoFrame = <div data-shell-overlay={layout.tao === "overlay" ? "true" : undefined} role={layout.tao === "overlay" ? "dialog" : undefined} aria-modal={layout.tao === "overlay" || undefined} aria-label={t("shell.tao")} style={frame(layout.tao, shell.layout.tao.edge, taoSide ? layout.taoSize : undefined, taoSide ? undefined : layout.taoSize)}><SurfaceSlot id="tao" /></div>;
  return <div ref={frameRef} data-testid="shell-root" data-lane={lane} data-immersive={shell.immersive} data-rail-edge={railEdge} data-mode={layout.mode} data-overlay={winner ?? ""} data-navigator-placement={layout.navigator} className="relative flex-1 flex min-h-0 min-w-0 isolate" style={{ flexDirection: horizontalRail ? (railEdge === "top" ? "column" : "column-reverse") : railEdge === "right" ? "row-reverse" : "row" }}>
    <GlobalRail width={railWidth} hidden={!railVisible} />
    <div className="relative flex flex-1 min-w-0 min-h-0">
      <div data-shell-overlay={layout.navigator === "overlay" ? "true" : undefined} role={layout.navigator === "overlay" ? "dialog" : undefined} aria-modal={layout.navigator === "overlay" || undefined} aria-label={t("shell.navigator")} style={frame(layout.navigator === "overlay" && !shell.navigatorOverlay ? "hidden" : layout.navigator, "left", layout.navigatorWidth)}>{navigator}</div>
      {layout.navigator === "dock" && <ShellResizeHandle kind="navigator" value={shell.layout.navigator.width} min={200} max={400} onPreview={(value) => setPreview((p) => ({ ...p, navigator: value }))} onChange={(width) => shell.updateLayout((l) => ({ ...l, navigator: { ...l.navigator, width } }))} />}
      {shell.layout.tao.edge === "left" && taoFrame}
      <div className="relative flex-1 flex flex-col min-w-0 min-h-0">
        {shell.layout.tao.edge === "top" && taoFrame}
        <div data-testid="shell-work-area" tabIndex={-1} className="relative flex-1 min-h-0 min-w-0" inert={!!overlay || !!shell.laneSelection} aria-hidden={!!overlay || !!shell.laneSelection}>{children}</div>
        {layout.bottom !== "hidden" && bottomPanel && <div data-shell-overlay={layout.bottom === "overlay" ? "true" : undefined} role={layout.bottom === "overlay" ? "dialog" : undefined} aria-modal={layout.bottom === "overlay" || undefined} aria-label={t("shell.panel")} style={frame(layout.bottom, "bottom", undefined, layout.bottomSize)}><ShellResizeHandle kind="bottom" value={layout.bottomSize} min={220} max={600} onPreview={(value) => setPreview((p) => ({ ...p, bottom: value }))} onChange={(value) => shell.resizePanel(bottomPanel.id, value)} /><ContextPanelHost panels={bottom} activeId={bottomPanel.id} edge="bottom" /></div>}
        {shell.layout.tao.edge === "bottom" && taoFrame}
        {shell.laneSelection && <div data-testid="shell-lane-empty" className="absolute inset-0 p-8" style={{ background: "var(--taomni-sidebar-bg)", color: "var(--taomni-text)" }}><p>{t("shell.emptyLane")}</p><div className="flex gap-3 mt-3"><button data-testid="shell-lane-empty-home" className="taomni-button" onClick={() => { shell.selectLane(null); useAppStore.getState().setActiveTab("welcome"); }}>{t("shell.home")}</button>{onCreateLane && <button data-testid="shell-lane-empty-create" className="taomni-button" onClick={() => onCreateLane(lane)}>{t(lane === "build" ? "shell.workspaces" : lane === "communicate" ? "shell.mail" : lane === "utility" ? "menu.tools" : "shell.newSession")}</button>}</div></div>}
      </div>
      {layout.right !== "hidden" && rightPanel && <div data-shell-overlay={layout.right === "overlay" ? "true" : undefined} role={layout.right === "overlay" ? "dialog" : undefined} aria-modal={layout.right === "overlay" || undefined} aria-label={t("shell.panel")} className="relative" style={frame(layout.right, "right", layout.rightSize)}><ContextPanelHost panels={right} activeId={rightPanel.id} edge="right" /><ShellResizeHandle kind="right" value={layout.rightSize} min={280} max={600} onPreview={(value) => setPreview((p) => ({ ...p, right: value }))} onChange={(value) => shell.resizePanel(rightPanel.id, value)} /></div>}
      {shell.layout.tao.edge === "right" && taoFrame}
      {shell.warning && <button data-testid="shell-layout-warning" className="absolute left-2 bottom-2 z-30 taomni-button text-xs" onClick={() => shell.resetLayout()}>{t("shell.layoutWarning")}</button>}
      <div className="shell-immersive-extras contents">{extras}</div>
      <div hidden><SurfaceSlot id="parking" /></div>
    </div>
  </div>;
}
export function ShellResizeHandle({ kind, value, min, max, onChange, onPreview }: { kind: "navigator" | "right" | "bottom"; value: number; min: number; max: number; onChange(value: number): void; onPreview?(value: number | undefined): void }) {
  const vertical = kind !== "bottom";
  const cancelDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelDrag.current?.(), []);
  return <div data-testid={kind === "navigator" ? "main-sidebar-resize-handle" : "shell-host-resize"} data-edge={kind} role="separator" tabIndex={0}
    aria-orientation={vertical ? "vertical" : "horizontal"} aria-valuenow={Math.round(value)} aria-valuemin={min} aria-valuemax={max}
    className={kind === "navigator" ? "w-[6px] shrink-0 cursor-col-resize hover:bg-[var(--taomni-accent)]" : vertical ? "absolute inset-y-0 left-0 w-[6px] cursor-col-resize hover:bg-[var(--taomni-accent)]" : "absolute top-0 inset-x-0 h-[6px] cursor-row-resize hover:bg-[var(--taomni-accent)] z-20"}
    onKeyDown={(e) => { const delta = e.shiftKey ? 32 : 8; const next = e.key === "Home" ? min : e.key === "End" ? max : ["ArrowLeft", "ArrowUp"].includes(e.key) ? value - delta : ["ArrowRight", "ArrowDown"].includes(e.key) ? value + delta : null; if (next !== null) { e.preventDefault(); onChange(Math.min(max, Math.max(min, next))); useShellLayoutStore.getState().flush(); } }}
    onPointerDown={(e) => { if (e.button !== 0) return; e.preventDefault(); cancelDrag.current?.(); const start = vertical ? e.clientX : e.clientY; let candidate = value; const move = (event: PointerEvent) => { candidate = Math.min(max, Math.max(min, value + ((vertical ? event.clientX : event.clientY) - start) * (kind === "navigator" ? 1 : -1))); onPreview?.(candidate); };
      const cleanup = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", commit); window.removeEventListener("pointercancel", cancel); window.removeEventListener("keydown", key); cancelDrag.current = null; onPreview?.(undefined); };
      const commit = () => { cleanup(); onChange(candidate); useShellLayoutStore.getState().flush(); }, cancel = () => cleanup(), key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); cancel(); } };
      cancelDrag.current = cancel;
      window.addEventListener("pointermove", move); window.addEventListener("pointerup", commit, { once: true }); window.addEventListener("pointercancel", cancel, { once: true }); window.addEventListener("keydown", key); }} />;
}
