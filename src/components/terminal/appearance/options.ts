import { type TranslateFn } from "../../../lib/i18n";
import { type TerminalCursorStyle, type TerminalRightClickBehavior } from "../../../lib/terminalProfile";

export function buildCursorOptions(t: TranslateFn): Array<{ label: string; style: TerminalCursorStyle; blink: boolean; }> {
  return [
    { label: t("terminalAppearance.cursorBlockBlink"), style: "block", blink: true },
    { label: t("terminalAppearance.cursorBlockSteady"), style: "block", blink: false },
    { label: t("terminalAppearance.cursorUnderlineBlink"), style: "underline", blink: true },
    { label: t("terminalAppearance.cursorUnderlineSteady"), style: "underline", blink: false },
    { label: t("terminalAppearance.cursorBarBlink"), style: "bar", blink: true },
    { label: t("terminalAppearance.cursorBarSteady"), style: "bar", blink: false },
  ];
}

export function buildRightClickOptions(t: TranslateFn): Array<{ label: string; value: TerminalRightClickBehavior; }> {
  return [
    { label: t("terminalAppearance.rightClickContextMenu"), value: "menu" },
    { label: t("terminalAppearance.rightClickPaste"), value: "paste" },
    { label: t("terminalAppearance.rightClickCopyOrPaste"), value: "copy-or-paste" },
  ];
}
