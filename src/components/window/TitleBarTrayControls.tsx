import { Monitor, Moon, Sun, PanelTopClose, PanelTopOpen, SplitSquareVertical, Users, Bot } from "lucide-react";
import { appThemeModeLabel, useAppTheme, type AppThemeMode } from "../../lib/appTheme";
import { useAppStore } from "../../stores/appStore";
import { useChatStore } from "../../stores/chatStore";
import { useAiStore } from "../../stores/aiStore";
import { PttButton } from "./PttButton";

const THEME_MODES: Array<{ mode: AppThemeMode; icon: React.ReactNode }> = [
  { mode: "light", icon: <Sun className="w-[16px] h-[16px]" /> },
  { mode: "dark", icon: <Moon className="w-[16px] h-[16px]" /> },
  { mode: "system", icon: <Monitor className="w-[16px] h-[16px]" /> },
];

export function TitleBarTrayControls() {
  const { mode, resolvedTheme, setMode } = useAppTheme();
  const compactMode = useAppStore((s) => s.compactMode);
  const toggleCompactMode = useAppStore((s) => s.toggleCompactMode);
  const terminalSplitActive = useAppStore((s) => s.terminalSplitActive);
  const multiExecActive = useAppStore((s) => s.multiExecActive);
  const toggleTerminalSplit = useAppStore((s) => s.toggleTerminalSplit);
  const toggleMultiExec = useAppStore((s) => s.toggleMultiExec);
  const drawerOpen = useChatStore((s) => s.drawerOpen);
  const drawerScope = useChatStore((s) => s.drawerScope);
  const toggleGlobalChat = useChatStore((s) => s.toggleGlobalChat);
  const aiFullyDisabled = useAiStore((s) => s.config?.fully_disabled === true);

  const currentIndex = THEME_MODES.findIndex((item) => item.mode === mode);
  const current = THEME_MODES[currentIndex] ?? THEME_MODES[0];
  const next = THEME_MODES[(currentIndex + 1) % THEME_MODES.length] ?? THEME_MODES[0];

  return (
    <div className="moba-titlebar-tray flex items-stretch self-stretch shrink-0" data-testid="titlebar-tray">
      {/* Voice group */}
      <div className="moba-titlebar-tray-group flex items-stretch self-stretch">
        <PttButton />
      </div>

      <TrayGroupSeparator />

      {/* View group */}
      <div className="moba-titlebar-tray-group flex items-stretch self-stretch">
        <TrayButton
          testId="theme-cycle"
          title={`Theme: ${appThemeModeLabel(mode)} (${resolvedTheme}). Click for ${appThemeModeLabel(next.mode)}.`}
          ariaLabel="Cycle application theme"
          onClick={() => setMode(next.mode)}
        >
          {current.icon}
        </TrayButton>
        <TrayButton
          testId="compact-toggle"
          title={compactMode ? "Exit compact mode" : "Enter compact mode"}
          ariaLabel={compactMode ? "Exit compact mode" : "Enter compact mode"}
          active={compactMode}
          onClick={toggleCompactMode}
        >
          {compactMode ? <PanelTopOpen className="w-[16px] h-[16px]" /> : <PanelTopClose className="w-[16px] h-[16px]" />}
        </TrayButton>
      </div>

      <TrayGroupSeparator />

      {/* Terminal layout group */}
      <div className="moba-titlebar-tray-group flex items-stretch self-stretch">
        <TrayButton
          testId="tab-split-view"
          title={terminalSplitActive ? "Disable terminal split view" : "Enable terminal split view"}
          ariaLabel={terminalSplitActive ? "Disable terminal split view" : "Enable terminal split view"}
          active={terminalSplitActive}
          onClick={toggleTerminalSplit}
        >
          <SplitSquareVertical className="w-[16px] h-[16px]" />
        </TrayButton>
        <TrayButton
          testId="tab-multiexec-toggle"
          title={multiExecActive ? "Disable MultiExec" : "Enable MultiExec"}
          ariaLabel={multiExecActive ? "Disable MultiExec" : "Enable MultiExec"}
          active={multiExecActive}
          onClick={toggleMultiExec}
        >
          <Users className="w-[16px] h-[16px]" />
        </TrayButton>
      </div>

      {!aiFullyDisabled && (
        <>
          <TrayGroupSeparator />
          {/* AI chat group */}
          <div className="moba-titlebar-tray-group flex items-stretch self-stretch">
            <TrayButton
              testId="ai-chat-drawer-toggle"
              title={
                drawerOpen && drawerScope === "global"
                  ? "Close global AI Chat (Ctrl+L)"
                  : "Open global AI Chat (Ctrl+L)"
              }
              ariaLabel={drawerOpen && drawerScope === "global" ? "Close global AI Chat" : "Open global AI Chat"}
              active={drawerOpen && drawerScope === "global"}
              onClick={() => void toggleGlobalChat()}
            >
              <Bot className="w-[16px] h-[16px]" />
            </TrayButton>
          </div>
        </>
      )}
    </div>
  );
}

function TrayGroupSeparator() {
  return (
    <div
      aria-hidden="true"
      className="moba-titlebar-tray-group-sep self-stretch shrink-0"
    />
  );
}

function TrayButton({
  children,
  title,
  ariaLabel,
  onClick,
  active,
  testId,
}: {
  children: React.ReactNode;
  title: string;
  ariaLabel: string;
  onClick: () => void;
  active?: boolean;
  testId?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={ariaLabel}
      data-testid={testId}
      data-active={active || undefined}
      className="moba-titlebar-tray-btn h-full w-10 inline-flex items-center justify-center hover:bg-[var(--moba-hover)]"
      style={{ color: "var(--moba-text)" }}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
