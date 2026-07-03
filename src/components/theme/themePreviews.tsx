import type { CSSProperties } from "react";
import type { ITheme } from "@xterm/xterm";
import {
  CODE_THEME_DEFINITIONS,
  codeThemeVariablesFromPalette,
  getCodeThemeDefinition,
  type CodeThemeDefinition,
  type CodeThemeVars,
} from "../../lib/codeThemes";
import { TERMINAL_THEME_DEFINITIONS, getTerminalThemeDefinition } from "../../lib/themes";
import {
  SYSTEM_DARK_TERMINAL_THEME,
  SYSTEM_LIGHT_TERMINAL_THEME,
  SYSTEM_TERMINAL_THEME,
} from "../../lib/terminalProfile";
import type { AppThemeMode, ResolvedAppTheme } from "../../lib/appTheme";
import type { NotesTheme } from "../../stores/notesStore";
import { notesThemeStyle } from "../../lib/notes/notesTheme";
import { mailCodeThemeValue } from "../../lib/mailTheme";
import { CODE_VIEW_TERMINAL_THEME_PREFIX } from "../../lib/codeViewProfile";
import type { ThemePreviewOption } from "./ThemePreviewSelect";

function valueOr(value: string | undefined, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

export function TerminalThemeLinePreview({ theme }: { theme: ITheme }) {
  const bg = valueOr(theme.background, "#1d1f21");
  const fg = valueOr(theme.foreground, "#eaeaea");
  return (
    <span
      className="h-7 min-w-0 rounded border px-2 inline-flex items-center gap-1 overflow-hidden taomni-mono text-[11px]"
      style={{ background: bg, color: fg, borderColor: valueOr(theme.selectionBackground, bg) }}
    >
      <span style={{ color: valueOr(theme.green, "#62d36f") }}>user@host</span>
      <span className="opacity-70">:</span>
      <span style={{ color: valueOr(theme.blue, "#83a7d8") }}>~/srv</span>
      <span className="opacity-80">$</span>
      <span className="truncate">tail -f app.log</span>
    </span>
  );
}

export function CodeThemeLinePreview({ vars }: { vars: CodeThemeVars | null }) {
  const bg = vars?.["--taomni-code-bg"] ?? "var(--taomni-code-bg)";
  const fg = vars?.["--taomni-code-text"] ?? "var(--taomni-code-text)";
  const keyword = vars?.["--taomni-code-syntax-keyword"] ?? "var(--taomni-code-syntax-keyword)";
  const variable = vars?.["--taomni-code-syntax-variable"] ?? "var(--taomni-code-syntax-variable)";
  const string = vars?.["--taomni-code-syntax-string"] ?? "var(--taomni-code-syntax-string)";
  const punctuation = vars?.["--taomni-code-syntax-punctuation"] ?? "var(--taomni-code-syntax-punctuation)";
  const border = vars?.["--taomni-code-border"] ?? "var(--taomni-code-border)";
  return (
    <span
      className="h-7 min-w-0 rounded border px-2 inline-flex items-center overflow-hidden taomni-mono text-[11px]"
      style={{ background: bg, color: fg, borderColor: border }}
    >
      <span style={{ color: keyword }}>const</span>
      <span>&nbsp;</span>
      <span style={{ color: variable }}>theme</span>
      <span style={{ color: punctuation }}>&nbsp;=&nbsp;</span>
      <span style={{ color: string }}>"taomni"</span>
      <span style={{ color: punctuation }}>;</span>
    </span>
  );
}

export function SplitThemeLinePreview({
  left,
  right,
}: {
  left: CSSProperties;
  right: CSSProperties;
}) {
  return (
    <span className="h-7 min-w-0 rounded border border-[var(--taomni-divider)] inline-flex overflow-hidden text-[11px]">
      <span className="w-1/2 px-2 inline-flex items-center gap-1 overflow-hidden" style={left}>
        <span className="font-semibold">Aa</span>
        <span className="truncate opacity-80">Light</span>
      </span>
      <span className="w-1/2 px-2 inline-flex items-center gap-1 overflow-hidden" style={right}>
        <span className="font-semibold">Aa</span>
        <span className="truncate opacity-80">Dark</span>
      </span>
    </span>
  );
}

export function AppThemeLinePreview({ mode }: { mode: AppThemeMode }) {
  const light: CSSProperties = { background: "#f8fafc", color: "#0f172a" };
  const dark: CSSProperties = { background: "#111827", color: "#f8fafc" };
  if (mode === "system") return <SplitThemeLinePreview left={light} right={dark} />;
  const style = mode === "dark" ? dark : light;
  return (
    <span
      className="h-7 min-w-0 rounded border px-2 inline-flex items-center gap-2 overflow-hidden text-[11px]"
      style={{ ...style, borderColor: mode === "dark" ? "#334155" : "#cbd5e1" }}
    >
      <span className="h-2.5 w-2.5 rounded-full" style={{ background: mode === "dark" ? "#60a5fa" : "#4f46e5" }} />
      <span className="font-semibold">Aa</span>
      <span className="truncate opacity-80">Inbox preview</span>
    </span>
  );
}

export function NotesThemeLinePreview({ theme }: { theme: NotesTheme }) {
  const style = notesThemeStyle(theme) as Record<string, string>;
  const bg = style["--taomni-card-bg"] ?? "var(--taomni-card-bg)";
  const fg = style["--taomni-text"] ?? "var(--taomni-text)";
  const border = style["--taomni-card-border"] ?? "var(--taomni-card-border)";
  const accent = style["--taomni-accent"] ?? "var(--taomni-accent)";
  return (
    <span
      className="h-7 min-w-0 rounded border px-2 inline-flex items-center gap-2 overflow-hidden text-[11px]"
      style={{ background: bg, color: fg, borderColor: border }}
    >
      <span className="h-2.5 w-2.5 rounded-sm" style={{ background: accent }} />
      <span className="font-semibold truncate">Note</span>
      <span className="truncate opacity-75">Plan next step</span>
    </span>
  );
}

export function codeThemeVarsForDefinition(definition: CodeThemeDefinition): CodeThemeVars {
  return codeThemeVariablesFromPalette(definition.palette);
}

export function codeThemeVarsById(id: string): CodeThemeVars | null {
  const definition = getCodeThemeDefinition(id);
  return definition ? codeThemeVariablesFromPalette(definition.palette) : null;
}

export function terminalThemeOptionValue(id: string): string {
  return id;
}

export function buildTerminalThemeOptions({
  includeSystem = false,
  systemLabel = "Follow system theme",
  customValue,
  customTheme,
  customLabel = "Custom colors",
  darkGroup = "Dark",
  lightGroup = "Light",
}: {
  includeSystem?: boolean;
  systemLabel?: string;
  customValue?: string;
  customTheme?: ITheme | null;
  customLabel?: string;
  darkGroup?: string;
  lightGroup?: string;
} = {}): ThemePreviewOption[] {
  const options: ThemePreviewOption[] = [];
  if (includeSystem) {
    options.push({
      value: SYSTEM_TERMINAL_THEME,
      label: systemLabel,
      preview: (
        <SplitThemeLinePreview
          left={{
            background: getTerminalThemeDefinition(SYSTEM_LIGHT_TERMINAL_THEME)?.theme.background ?? "#eef3f7",
            color: getTerminalThemeDefinition(SYSTEM_LIGHT_TERMINAL_THEME)?.theme.foreground ?? "#1d2633",
          }}
          right={{
            background: getTerminalThemeDefinition(SYSTEM_DARK_TERMINAL_THEME)?.theme.background ?? "#101420",
            color: getTerminalThemeDefinition(SYSTEM_DARK_TERMINAL_THEME)?.theme.foreground ?? "#d7dde8",
          }}
        />
      ),
      testId: "terminal-theme-option-system",
    });
  }
  if (customTheme && customValue) {
    options.push({
      value: customValue,
      label: customLabel,
      preview: <TerminalThemeLinePreview theme={customTheme} />,
      testId: "terminal-theme-option-custom",
    });
  }
  for (const definition of TERMINAL_THEME_DEFINITIONS) {
    options.push({
      value: terminalThemeOptionValue(definition.id),
      label: definition.name,
      group: definition.variant === "light" ? lightGroup : darkGroup,
      preview: <TerminalThemeLinePreview theme={definition.theme} />,
      testId: `terminal-theme-option-${definition.id}`,
    });
  }
  return options;
}

export function buildCodeThemeOptions({
  systemLabel,
  appLabel,
  terminalLabel,
  terminalTheme,
  darkGroup,
  lightGroup,
  terminalGroup,
}: {
  systemLabel: string;
  appLabel: string;
  terminalLabel: string;
  terminalTheme: ITheme;
  darkGroup: string;
  lightGroup: string;
  terminalGroup: string;
}): ThemePreviewOption[] {
  return [
    {
      value: "system",
      label: systemLabel,
      preview: (
        <SplitThemeLinePreview
          left={{ background: "#ffffff", color: "#393a34" }}
          right={{ background: "#282a36", color: "#f8f8f2" }}
        />
      ),
      testId: "code-theme-option-system",
    },
    {
      value: "app",
      label: appLabel,
      preview: <CodeThemeLinePreview vars={null} />,
      testId: "code-theme-option-app",
    },
    {
      value: "terminal",
      label: terminalLabel,
      preview: <TerminalThemeLinePreview theme={terminalTheme} />,
      testId: "code-theme-option-terminal",
    },
    ...CODE_THEME_DEFINITIONS.map((definition) => ({
      value: definition.id,
      label: definition.name,
      group: definition.variant === "light" ? lightGroup : darkGroup,
      preview: <CodeThemeLinePreview vars={codeThemeVarsForDefinition(definition)} />,
      testId: `code-theme-option-${definition.id}`,
    })),
    ...TERMINAL_THEME_DEFINITIONS.map((definition) => ({
      value: `${CODE_VIEW_TERMINAL_THEME_PREFIX}${definition.id}`,
      label: definition.name,
      group: terminalGroup,
      preview: <TerminalThemeLinePreview theme={definition.theme} />,
      testId: `code-theme-option-terminal-${definition.id}`,
    })),
  ];
}

export function buildMailThemeOptions({
  systemLabel,
  codeDarkGroup,
  codeLightGroup,
  terminalGroup,
  customValue,
  customTheme,
  customLabel,
}: {
  systemLabel: string;
  codeDarkGroup: string;
  codeLightGroup: string;
  terminalGroup: string;
  customValue?: string;
  customTheme?: ITheme | null;
  customLabel?: string;
}): ThemePreviewOption[] {
  return [
    {
      value: SYSTEM_TERMINAL_THEME,
      label: systemLabel,
      preview: (
        <SplitThemeLinePreview
          left={{
            background: getTerminalThemeDefinition(SYSTEM_LIGHT_TERMINAL_THEME)?.theme.background ?? "#eef3f7",
            color: getTerminalThemeDefinition(SYSTEM_LIGHT_TERMINAL_THEME)?.theme.foreground ?? "#1d2633",
          }}
          right={{
            background: getTerminalThemeDefinition(SYSTEM_DARK_TERMINAL_THEME)?.theme.background ?? "#101420",
            color: getTerminalThemeDefinition(SYSTEM_DARK_TERMINAL_THEME)?.theme.foreground ?? "#d7dde8",
          }}
        />
      ),
      testId: "mail-theme-option-system",
    },
    ...(customTheme && customLabel && customValue
      ? [{
          value: customValue,
          label: customLabel,
          preview: <TerminalThemeLinePreview theme={customTheme} />,
          testId: "mail-theme-option-custom",
        }]
      : []),
    ...CODE_THEME_DEFINITIONS.map((definition) => ({
      value: mailCodeThemeValue(definition.id),
      label: definition.name,
      group: definition.variant === "light" ? codeLightGroup : codeDarkGroup,
      preview: <CodeThemeLinePreview vars={codeThemeVarsForDefinition(definition)} />,
      testId: `mail-theme-option-code-${definition.id}`,
    })),
    ...TERMINAL_THEME_DEFINITIONS.map((definition) => ({
      value: definition.id,
      label: definition.name,
      group: terminalGroup,
      preview: <TerminalThemeLinePreview theme={definition.theme} />,
      testId: `mail-theme-option-terminal-${definition.id}`,
    })),
  ];
}

export function resolvedAppThemeForMode(mode: AppThemeMode, resolvedTheme: ResolvedAppTheme): ResolvedAppTheme {
  return mode === "system" ? resolvedTheme : mode;
}
