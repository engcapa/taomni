import { useLayoutEffect } from "react";
import { useAppStore } from "../stores/appStore";
import { useChatStore } from "../stores/chatStore";
import { useShellLayoutStore } from "../stores/shellLayoutStore";
import { installSidebarBridge, installTaoBridge } from "../lib/shell/layoutBridge";
import { tabLane } from "../lib/shell/tabPresentation";
import { safeWorkspace } from "../lib/shell/shellLayoutPersistence";

export function useShellLayoutBridge() {
  useLayoutEffect(() => {
    const shell = useShellLayoutStore.getState(); shell.initialize();
    const lane = () => { const app = useAppStore.getState(), s = useShellLayoutStore.getState(); const tab = app.tabs.find((t) => t.id === app.activeTabId); return s.laneSelection ?? (tab ? tabLane(tab, s.laneOverrides[tab.id]) : "home"); };
    const sync = () => {
      const s = useShellLayoutStore.getState(), app = useAppStore.getState(), chat = useChatStore.getState();
      const collapsed = s.layout.navigator.collapsedByLane[lane()];
      const activeSideTab = s.layout.navigator.lastArea === "sessions" ? "sessions" : app.activeSideTab;
      if (collapsed !== app.sidebarCollapsed || activeSideTab !== app.activeSideTab) useAppStore.setState({ sidebarCollapsed: collapsed, activeSideTab });
      const tao = s.layout.tao;
      if (chat.drawerPosition !== tao.edge || chat.drawerWidth !== tao.width || chat.drawerHeight !== tao.height || chat.drawerPinned !== tao.pinned || chat.drawerFloatingOpacity !== tao.opacity || chat.ribbonOffsetRatio !== tao.ribbonOffsetRatio)
        useChatStore.setState({ drawerPosition: tao.edge, drawerWidth: tao.width, drawerHeight: tao.height, drawerPinned: tao.pinned, drawerFloatingOpacity: tao.opacity, ribbonOffsetRatio: tao.ribbonOffsetRatio });
      if (chat.drawerOpen !== s.taoOpen) useChatStore.setState({ drawerOpen: s.taoOpen });
    };
    const offSidebar = installSidebarBridge({ setCollapsed: (collapsed) => useShellLayoutStore.getState().setNavigatorCollapsed(lane(), collapsed),
      toggle: () => { const s = useShellLayoutStore.getState(); s.toggleNavigator(s.layout.navigator.lastArea, lane()); },
      select: (area) => { useAppStore.setState({ activeSideTab: area }); useShellLayoutStore.getState().toggleNavigator(area === "sessions" ? "sessions" : "workspaces", lane()); }, apply: sync });
    const offTao = installTaoBridge({ update: (patch) => useShellLayoutStore.getState().updateLayout((layout) => ({ ...layout, tao: { ...layout.tao, ...patch } })) });
    let lastActive = useAppStore.getState().activeTabId;
    if (lastActive) shell.visitTab(lastActive);
    const offApp = useAppStore.subscribe((state, previous) => {
      if (state.activeTabId !== lastActive) { lastActive = state.activeTabId; if (lastActive) useShellLayoutStore.getState().visitTab(lastActive); }
      if (state.tabs !== previous.tabs) useShellLayoutStore.getState().pruneTabs(state.tabs.map((t) => t.id));
      if (state.tabs !== previous.tabs || state.codeWorkspaceByTab !== previous.codeWorkspaceByTab) state.tabs.forEach((tab, order) => {
        if (tab.codeWorkspace && state.codeWorkspaceByTab[tab.id]) {
          const workspace = safeWorkspace(tab.codeWorkspace), workspaceInstanceId = tab.codeWorkspace.workspaceInstanceId;
          if (workspace && workspaceInstanceId) useShellLayoutStore.getState().bindRestoreSource(tab.id, { kind: "workspace", workspaceInstanceId, workspace }, order);
        }
      });
      sync();
    });
    const offShell = useShellLayoutStore.subscribe(sync);
    const offChat = useChatStore.subscribe((state, previous) => { if (state.drawerOpen !== previous.drawerOpen && state.drawerOpen !== useShellLayoutStore.getState().taoOpen) useShellLayoutStore.getState().setTaoOpen(state.drawerOpen); });
    sync();
    const flush = () => useShellLayoutStore.getState().flush(); window.addEventListener("pagehide", flush);
    return () => { offApp(); offShell(); offChat(); offSidebar(); offTao(); window.removeEventListener("pagehide", flush); flush(); };
  }, []);
}
