import { Monitor, Moon, Sun, PanelTopClose, PanelTopOpen, SplitSquareVertical, Users, Bot } from "lucide-react";
import { useAppTheme, type AppThemeMode } from "../../lib/appTheme";
import { useAppStore } from "../../stores/appStore";
import { useChatStore } from "../../stores/chatStore";
import { useAiStore } from "../../stores/aiStore";
import { getAppPlatform } from "../../lib/runtime";
import { useT } from "../../lib/i18n";
import { useAppThemeI18nLabel } from "../../lib/i18n/labels";
import { PttButton } from "./PttButton";
import { LanguageSwitcher } from "./LanguageSwitcher";

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
  const t = useT();
  const themeLabel = useAppThemeI18nLabel();

  // Compact mode is removed on macOS — the global menu bar replaces the
  // condensed in-app chrome there. The toggle stays on Windows/Linux.
  const compactAvailable = getAppPlatform() !== "macos";

  const currentIndex = THEME_MODES.findIndex((item) => item.mode === mode);
  const current = THEME_MODES[currentIndex] ?? THEME_MODES[0];
  const next = THEME_MODES[(currentIndex + 1) % THEME_MODES.length] ?? THEME_MODES[0];

  const compactTitle = compactMode ? t("titlebar.exitCompact") : t("titlebar.enterCompact");
  const splitTitle = terminalSplitActive ? t("titlebar.disableSplit") : t("titlebar.enableSplit");
  const multiExecTitle = multiExecActive ? t("titlebar.disableMultiExec") : t("titlebar.enableMultiExec");
  const chatOpenForGlobal = drawerOpen && drawerScope === "global";
  const chatTitle = chatOpenForGlobal ? t("titlebar.closeGlobalChat") : t("titlebar.openGlobalChat");
  const chatAria = chatOpenForGlobal ? t("titlebar.closeGlobalChatAria") : t("titlebar.openGlobalChatAria");

  return (
    <div className="taomni-titlebar-tray flex items-stretch self-stretch shrink-0" data-testid="titlebar-tray">
      {/* Voice group */}
      <div className="taomni-titlebar-tray-group flex items-stretch self-stretch">
        <PttButton />
      </div>

      <TrayGroupSeparator />

      {/* View group */}
      <div className="taomni-titlebar-tray-group flex items-stretch self-stretch">
        <TrayButton
          testId="theme-cycle"
          title={t("titlebar.cycleTheme", {
            mode: themeLabel(mode),
            resolved: resolvedTheme,
            next: themeLabel(next.mode),
          })}
          ariaLabel={t("titlebar.cycleThemeAria")}
          onClick={() => setMode(next.mode)}
        >
          {current.icon}
        </TrayButton>
        {compactAvailable && (
          <TrayButton
            testId="compact-toggle"
            title={compactTitle}
            ariaLabel={compactTitle}
            active={compactMode}
            onClick={toggleCompactMode}
          >
            {compactMode ? <PanelTopOpen className="w-[16px] h-[16px]" /> : <PanelTopClose className="w-[16px] h-[16px]" />}
          </TrayButton>
        )}
      </div>

      <TrayGroupSeparator />

      {/* Terminal layout group */}
      <div className="taomni-titlebar-tray-group flex items-stretch self-stretch">
        <TrayButton
          testId="tab-split-view"
          title={splitTitle}
          ariaLabel={splitTitle}
          active={terminalSplitActive}
          onClick={toggleTerminalSplit}
        >
          <SplitSquareVertical className="w-[16px] h-[16px]" />
        </TrayButton>
        <TrayButton
          testId="tab-multiexec-toggle"
          title={multiExecTitle}
          ariaLabel={multiExecTitle}
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
          <div className="taomni-titlebar-tray-group flex items-stretch self-stretch">
            <TrayButton
              testId="ai-chat-drawer-toggle"
              title={chatTitle}
              ariaLabel={chatAria}
              active={chatOpenForGlobal}
              onClick={() => void toggleGlobalChat()}
            >
              <Bot className="w-[16px] h-[16px]" />
            </TrayButton>
          </div>
        </>
      )}

      <TrayGroupSeparator />

      {/* Language switcher — anchored to the rightmost tray slot so it always
          sits at the top-right of the title bar, in both regular and compact
          layouts. */}
      <div className="taomni-titlebar-tray-group flex items-stretch self-stretch">
        <LanguageSwitcher />
      </div>
    </div>
  );
}

function TrayGroupSeparator() {
  return (
    <div
      aria-hidden="true"
      className="taomni-titlebar-tray-group-sep self-stretch shrink-0"
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
      className="taomni-titlebar-tray-btn h-full w-10 inline-flex items-center justify-center hover:bg-[var(--taomni-hover)]"
      style={{ color: "var(--taomni-text)" }}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
