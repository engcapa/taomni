import "@xterm/xterm/css/xterm.css";
import { TerminalPanelView } from "./panel/TerminalPanelView";
import { type TerminalPanelProps } from "./panel/types";
import { useTerminalCommands } from "./panel/useTerminalCommands";
import { useTerminalHighlights } from "./panel/useTerminalHighlights";
import { useTerminalInteraction } from "./panel/useTerminalInteraction";
import { useTerminalLifecycle } from "./panel/useTerminalLifecycle";
import { useTerminalPanelState } from "./panel/useTerminalPanelState";
import { useTerminalRegistry } from "./panel/useTerminalRegistry";


// ESC [ 3 J

export function TerminalPanel({
  bookmarkOptionsJson,
  tabId,
  tabTitle = "Terminal",
  theme = "classic",
  ssh,
  commandTerminal,
  localShell,
  terminalProfile,
  onTerminalProfileChange,
  adoptedTerminal,
  sockscapTerminal,
  initialCwd,
  workspaceRoot,
  preserveSessionOnUnmount = false,
  detachedWindowControls,
  onDetachedStateChange,
  visible = true,
  activeForShortcuts = visible,
  inputLocked = false,
  onCwdChange,
  cwdRequestToken = 0,
  onSessionReady,
  onSessionLaunchFailed,
  onOutput,
  onTaskExit,
  onUploadLocalPaths,
  multiExecActive,
  isMultiExecTarget,
  onInputBroadcast,
  sftpToggle,
  chatToggle,
  gitToggle,
  detachToggle,
}: TerminalPanelProps) {
  const panel = useTerminalPanelState({
    bookmarkOptionsJson,
    onCwdChange,
    onSessionReady,
    onSessionLaunchFailed,
    onOutput,
    onTaskExit,
    onUploadLocalPaths,
    onInputBroadcast,
    onTerminalProfileChange,
    onDetachedStateChange,
    preserveSessionOnUnmount,
    adoptedTerminal,
    workspaceRoot,
    multiExecActive,
    initialCwd,
    ssh,
    commandTerminal,
    sockscapTerminal,
    terminalProfile,
    tabId,
    theme,
    cwdRequestToken,
  });
  const interaction = useTerminalInteraction({
    panel,
    commandTerminal,
    ssh,
    localShell,
    sockscapTerminal,
    gitToggle,
    tabId,
    terminalProfile,
    tabTitle,
  });
  const commands = useTerminalCommands({
    tabId,
    tabTitle,
    panel,
    interaction,
    ssh,
  });
  const lifecycle = useTerminalLifecycle({
    panel,
    inputLocked,
    commands,
    interaction,
    gitToggle,
    tabId,
    initialCwd,
    cwdRequestToken,
    terminalProfile,
    theme,
    ssh,
    sockscapTerminal,
    commandTerminal,
    localShell,
    visible,
    activeForShortcuts,
  });
  const highlights = useTerminalHighlights({
    panel,
    interaction,
  });
  useTerminalRegistry({
    tabId,
    panel,
    tabTitle,
    interaction,
    localShell,
  });

  const panelClasses = [
    "relative w-full h-full",
    panel.fullscreen ? "fixed inset-0 z-[9000]" : "",
    panel.showScrollbar ? "" : "terminal-hide-scrollbar",
    panel.fontLigatures ? "terminal-font-ligatures" : "terminal-no-font-ligatures",
  ].filter(Boolean).join(" ");
  const resolvedTheme = panel.resolvePanelTheme(panel.themeName);

  return <TerminalPanelView
    panel={panel}
    activeForShortcuts={activeForShortcuts}
    inputLocked={inputLocked}
    panelClasses={panelClasses}
    resolvedTheme={resolvedTheme}
    isMultiExecTarget={isMultiExecTarget}
    commands={commands}
    interaction={interaction}
    lifecycle={lifecycle}
    sftpToggle={sftpToggle}
    chatToggle={chatToggle}
    detachToggle={detachToggle}
    detachedWindowControls={detachedWindowControls}
    highlights={highlights}
    ssh={ssh}
  />;
}


export { type AdoptedTerminalSession, type CommandTerminalConnectInfo, type DetachedTerminalWindowControls, type SshConnectInfo, type TerminalBlockSelection, type TerminalBlockSelectionCell, type TerminalLocalPathUploadRequest, type TerminalReattachState } from "./panel/types";


export { collectTerminalBlockSelectionText } from "./panel/buffer";
