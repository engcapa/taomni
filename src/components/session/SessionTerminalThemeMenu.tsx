import { useMemo } from "react";
import { Palette } from "lucide-react";
import type { SessionConfig } from "../../lib/ipc";
import type { TranslateFn } from "../../lib/i18n";
import {
  getSessionTerminalTheme,
  isTerminalThemeSession,
} from "../../lib/sessionTerminalTheme";
import { isCustomTerminalTheme, resolveTerminalTheme } from "../../lib/terminalProfile";
import { resolveThemeId } from "../../lib/themes";
import type { MenuItem } from "../ContextMenu";
import { ThemePreviewList } from "../theme/ThemePreviewSelect";
import { buildTerminalThemeOptions } from "../theme/themePreviews";

const MIXED_THEME_VALUE = "__mixed__";

export function buildSessionTerminalThemeMenuItem({
  sessions,
  t,
  onSelectTheme,
  onClose,
}: {
  sessions: readonly SessionConfig[];
  t: TranslateFn;
  onSelectTheme: (theme: string, sessions: readonly SessionConfig[]) => void | Promise<void>;
  onClose?: () => void;
}): MenuItem {
  const eligibleSessions = sessions.filter(isTerminalThemeSession);
  return {
    label: t("sessionTree.contextSetTerminalTheme"),
    testId: "context-menu-item-set-terminal-theme",
    icon: <Palette className="w-3 h-3" />,
    disabled: eligibleSessions.length === 0,
    customPanel: (
      <SessionTerminalThemeMenuPanel
        sessions={eligibleSessions}
        t={t}
        onSelect={(theme) => {
          void Promise.resolve(onSelectTheme(theme, eligibleSessions));
          onClose?.();
        }}
      />
    ),
  };
}

function SessionTerminalThemeMenuPanel({
  sessions,
  t,
  onSelect,
}: {
  sessions: readonly SessionConfig[];
  t: TranslateFn;
  onSelect: (theme: string) => void;
}) {
  const value = useMemo(() => currentThemeValue(sessions), [sessions]);
  const customTheme = value !== MIXED_THEME_VALUE && isCustomTerminalTheme(value)
    ? resolveTerminalTheme(value)
    : null;
  const listValue = customTheme ? value : value === MIXED_THEME_VALUE ? value : resolveThemeId(value);
  const options = useMemo(() => buildTerminalThemeOptions({
    includeSystem: true,
    systemLabel: t("terminalAppearance.themeSystemName"),
    customValue: customTheme ? value : undefined,
    customTheme,
    customLabel: t("terminalAppearance.themeCustomName"),
    darkGroup: t("terminalAppearance.themeVariantDark"),
    lightGroup: t("terminalAppearance.themeVariantLight"),
  }).map((option) => ({
    ...option,
    testId: `session-terminal-theme-option-${option.value.replace(/[^a-zA-Z0-9_-]+/g, "-")}`,
  })), [customTheme, t, value]);

  return (
    <ThemePreviewList
      value={listValue}
      options={options}
      testId="session-terminal-theme-list"
      className="w-[360px] max-w-[calc(100vw-24px)] rounded-md border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] p-1 shadow-lg"
      onChange={onSelect}
    />
  );
}

function currentThemeValue(sessions: readonly SessionConfig[]): string {
  const themes = new Set(sessions.map(getSessionTerminalTheme));
  if (themes.size !== 1) return MIXED_THEME_VALUE;
  return themes.values().next().value ?? MIXED_THEME_VALUE;
}
