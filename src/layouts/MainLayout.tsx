import { MainLayoutView } from "./main/MainLayoutView";
import { useMainConnectionActions } from "./main/useMainConnectionActions";
import { useMainLayoutChrome } from "./main/useMainLayoutChrome";
import { useMainLayoutState } from "./main/useMainLayoutState";
import { useMainMenuActions } from "./main/useMainMenuActions";
import { useMainSessionActions } from "./main/useMainSessionActions";
import { useMainTerminalIntegration } from "./main/useMainTerminalIntegration";
import { useMainUtilityTabs } from "./main/useMainUtilityTabs";
import { useMainWindowLifecycle } from "./main/useMainWindowLifecycle";
import { useMainWorkspaceOpening } from "./main/useMainWorkspaceOpening";

export function MainLayout() {
  const layout = useMainLayoutState({

  });
  const terminals = useMainTerminalIntegration({
    layout,
  });
  const windowLifecycle = useMainWindowLifecycle({
    layout,
  });
  const sessionActions = useMainSessionActions({
    layout,
  });
  const workspaceOpening = useMainWorkspaceOpening({
    layout,
    sessionActions,
  });
  const connections = useMainConnectionActions({
    layout,
    workspaceOpening,
    sessionActions,
  });
  const utilityTabs = useMainUtilityTabs({
    layout,
    workspaceOpening,
    connections,
    terminals,
    sessionActions,
  });
  const menuActions = useMainMenuActions({
    layout,
    sessionActions,
    utilityTabs,
    workspaceOpening,
  });
  const chrome = useMainLayoutChrome({
    layout,
    windowLifecycle,
    terminals,
  });

  return <MainLayoutView
    layout={layout}
    chrome={chrome}
    menuActions={menuActions}
    sessionActions={sessionActions}
    connections={connections}
    terminals={terminals}
    windowLifecycle={windowLifecycle}
    workspaceOpening={workspaceOpening}
    utilityTabs={utilityTabs}
  />;
}
