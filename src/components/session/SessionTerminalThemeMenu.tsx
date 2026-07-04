import { useMemo, useRef, useState } from "react";
import { Palette } from "lucide-react";
import type { SessionConfig } from "../../lib/ipc";
import type { TranslateFn } from "../../lib/i18n";
import {
  getSessionTerminalProfileForThemeUpdate,
  isTerminalThemeSession,
  type SessionTerminalAppearancePatch,
} from "../../lib/sessionTerminalTheme";
import { isCustomTerminalTheme, resolveTerminalTheme } from "../../lib/terminalProfile";
import { resolveThemeId } from "../../lib/themes";
import { useSystemFonts } from "../../lib/systemFonts";
import type { MenuItem } from "../ContextMenu";
import { buildTerminalThemeOptions } from "../theme/themePreviews";
import {
  DEFAULT_TERMINAL_APPEARANCE_MENU_LABELS,
  TerminalAppearanceMenuPanel,
  type TerminalAppearanceMenuLabels,
} from "../terminal/TerminalAppearanceMenuPanel";

const MIXED_THEME_VALUE = "__mixed__";

export function buildSessionTerminalThemeMenuItem({
  sessions,
  t,
  onSelectAppearance,
}: {
  sessions: readonly SessionConfig[];
  t: TranslateFn;
  onSelectAppearance: (patch: SessionTerminalAppearancePatch, sessions: readonly SessionConfig[]) => void | Promise<void>;
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
        onChangeAppearance={(patch) => {
          void Promise.resolve(onSelectAppearance(patch, eligibleSessions));
        }}
      />
    ),
  };
}

function SessionTerminalThemeMenuPanel({
  sessions,
  t,
  onChangeAppearance,
}: {
  sessions: readonly SessionConfig[];
  t: TranslateFn;
  onChangeAppearance: (patch: SessionTerminalAppearancePatch) => void;
}) {
  const fontState = useSystemFonts();
  const [draftPatch, setDraftPatch] = useState<SessionTerminalAppearancePatch>({});
  const draftPatchRef = useRef<SessionTerminalAppearancePatch>({});
  const profiles = useMemo(
    () => sessions.map((session) => ({
      ...getSessionTerminalProfileForThemeUpdate(session),
      ...draftPatch,
    })),
    [draftPatch, sessions],
  );
  const value = useMemo(() => commonValue(profiles.map((profile) => profile.theme)) ?? MIXED_THEME_VALUE, [profiles]);
  const customTheme = value !== MIXED_THEME_VALUE && isCustomTerminalTheme(value)
    ? resolveTerminalTheme(value)
    : null;
  const listValue = customTheme ? value : value === MIXED_THEME_VALUE ? value : resolveThemeId(value);
  const fontFamilyValue = useMemo(() => commonValue(profiles.map((profile) => profile.fontFamily)), [profiles]);
  const fontSizeValue = useMemo(() => commonValue(profiles.map((profile) => profile.fontSize)), [profiles]);
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
  const labels = useMemo<TerminalAppearanceMenuLabels>(() => ({
    ...DEFAULT_TERMINAL_APPEARANCE_MENU_LABELS,
    font: t("terminalAppearance.fontLabel"),
    mixedFont: t("terminalAppearance.mixedFonts"),
    monospaceFonts: t("terminalAppearance.fontGroupMonoSystem"),
    proportionalFonts: t("terminalAppearance.fontGroupProportional"),
    textSize: t("terminalAppearance.textSizeLabel"),
    decreaseTextSize: t("terminalAppearance.decreaseTextSize"),
    increaseTextSize: t("terminalAppearance.increaseTextSize"),
    fontSize: t("terminalAppearance.fontSizeAria"),
  }), [t]);
  const changeAppearance = (patch: SessionTerminalAppearancePatch) => {
    const next = { ...draftPatchRef.current, ...patch };
    draftPatchRef.current = next;
    setDraftPatch(next);
    onChangeAppearance(next);
  };

  return (
    <TerminalAppearanceMenuPanel
      themeValue={listValue}
      themeOptions={options}
      fonts={fontState.fonts}
      fontFamily={fontFamilyValue}
      fontSize={fontSizeValue}
      labels={labels}
      themeListTestId="session-terminal-theme-list"
      fontSelectTestId="session-terminal-font-select"
      fontSizeTestId="session-terminal-font-size"
      onChangeTheme={(theme) => changeAppearance({ theme })}
      onChangeFontFamily={(fontFamily) => changeAppearance({ fontFamily })}
      onChangeFontSize={(fontSize) => changeAppearance({ fontSize })}
    />
  );
}

function commonValue<T>(values: readonly T[]): T | null {
  if (values.length === 0) return null;
  const first = values[0];
  return values.every((value) => Object.is(value, first)) ? first : null;
}
