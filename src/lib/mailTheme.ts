import type { ITheme } from "@xterm/xterm";
import {
  getCodeThemeDefinition,
  isCodeThemeId,
  type CodeThemeDefinition,
} from "./codeThemes";
import { resolveTerminalThemeWithSystem } from "./terminalProfile";
import { getTerminalThemeDefinition, resolveThemeId } from "./themes";

export const MAIL_CODE_THEME_PREFIX = "code:";

export function mailCodeThemeValue(id: string): string {
  return `${MAIL_CODE_THEME_PREFIX}${id}`;
}

export function mailCodeThemeIdFromValue(value: string): string | null {
  if (!value.startsWith(MAIL_CODE_THEME_PREFIX)) return null;
  const id = value.slice(MAIL_CODE_THEME_PREFIX.length);
  return isCodeThemeId(id) ? id : null;
}

export function normalizeMailThemeSelectValue(value: string): string {
  const codeId = mailCodeThemeIdFromValue(value);
  if (codeId) return mailCodeThemeValue(codeId);
  if (isCodeThemeId(value) && !getTerminalThemeDefinition(value)) return mailCodeThemeValue(value);
  return resolveThemeId(value);
}

export function resolveMailTheme(value: string, prefersDark: boolean): ITheme {
  const codeId = mailCodeThemeIdFromValue(value)
    ?? (isCodeThemeId(value) && !getTerminalThemeDefinition(value) ? value : null);
  if (codeId) {
    const definition = getCodeThemeDefinition(codeId);
    if (definition) return terminalThemeFromCodeTheme(definition);
  }
  return resolveTerminalThemeWithSystem(value, prefersDark);
}

function terminalThemeFromCodeTheme(definition: CodeThemeDefinition): ITheme {
  const palette = definition.palette;
  return {
    background: palette.background,
    foreground: palette.foreground,
    cursor: palette.cursor ?? palette.foreground,
    selectionBackground: palette.selection ?? palette.background,
    black: palette.background,
    red: palette.deleted ?? palette.escape ?? palette.keyword,
    green: palette.added ?? palette.string,
    yellow: palette.number,
    blue: palette.modified ?? palette.function,
    magenta: palette.property ?? palette.keyword,
    cyan: palette.type,
    white: palette.foreground,
  };
}
