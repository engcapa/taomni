import { create } from "zustand";
import { setFileOpenPreferences, useFileOpenPreferences } from "../lib/openFile/preferences";

export type NotepadBackupMode = "none" | "simple" | "verbose";
export type NotepadPrintColorMode = "wysiwyg" | "bw" | "inv" | "none";

export interface NotepadPrintDefaults {
  range: "all" | "selection";
  lineNumbers: boolean;
  marginMm: number;
  header: string;
  footer: string;
  colorMode: NotepadPrintColorMode;
}

export interface NotepadPreferences {
  wrap: boolean;
  fontSize: number;
  backupSec: number;
  backupMode: NotepadBackupMode;
  backupDir: string;
  restoreSessionOnStartup: boolean;
  autoReloadCleanExternal: boolean;
  recentMax: number;
  defaultEol: "LF" | "CRLF" | "CR";
  defaultEncoding: string;
  untitledPattern: string;
  clickableLinks: boolean;
  showRuler: boolean;
  rulerCol: number;
  showLineNumbers: boolean;
  askWholeDocLineOp: boolean;
  copyCutWholeLineWhenEmpty: boolean;
  dragSelectedText: boolean;
  searchEngine: string;
  showChangeHistory: boolean;
  syncZoomAcrossSplit: boolean;
  windowsTerminalApp: "powershell" | "cmd";
  printDefaults: NotepadPrintDefaults;
}

export const NOTEPAD_PREFERENCES_KEY = "taomni.notepad.preferences.v1";

export const DEFAULT_NOTEPAD_PREFERENCES: NotepadPreferences = {
  wrap: false,
  fontSize: 13,
  backupSec: 30,
  backupMode: "none",
  backupDir: "",
  restoreSessionOnStartup: true,
  autoReloadCleanExternal: true,
  recentMax: 50,
  defaultEol: "LF",
  defaultEncoding: "UTF-8",
  untitledPattern: "新建 {n}",
  clickableLinks: true,
  showRuler: true,
  rulerCol: 80,
  showLineNumbers: true,
  askWholeDocLineOp: true,
  copyCutWholeLineWhenEmpty: true,
  dragSelectedText: true,
  searchEngine: "https://www.bing.com/search?q=",
  showChangeHistory: true,
  syncZoomAcrossSplit: false,
  windowsTerminalApp: "powershell",
  printDefaults: {
    range: "all",
    lineNumbers: true,
    marginMm: 20,
    header: "{name}",
    footer: "第 {page} 页",
    colorMode: "wysiwyg",
  },
};

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.round(num)));
}

function validatePreferences(raw: Partial<NotepadPreferences>): NotepadPreferences {
  const d = DEFAULT_NOTEPAD_PREFERENCES;
  const printRaw = (raw.printDefaults && typeof raw.printDefaults === "object" ? raw.printDefaults : {}) as Partial<NotepadPrintDefaults>;
  return {
    wrap: typeof raw.wrap === "boolean" ? raw.wrap : d.wrap,
    fontSize: clampInt(raw.fontSize, 8, 32, d.fontSize),
    backupSec: clampInt(raw.backupSec, 5, 300, d.backupSec),
    backupMode: raw.backupMode === "simple" || raw.backupMode === "verbose" ? raw.backupMode : "none",
    backupDir: typeof raw.backupDir === "string" ? raw.backupDir.trim() : d.backupDir,
    restoreSessionOnStartup: raw.restoreSessionOnStartup !== false,
    autoReloadCleanExternal: raw.autoReloadCleanExternal !== false,
    recentMax: clampInt(raw.recentMax, 5, 200, d.recentMax),
    defaultEol: raw.defaultEol === "CRLF" || raw.defaultEol === "CR" ? raw.defaultEol : "LF",
    defaultEncoding: typeof raw.defaultEncoding === "string" && raw.defaultEncoding.trim() ? raw.defaultEncoding.trim() : d.defaultEncoding,
    untitledPattern: typeof raw.untitledPattern === "string" && raw.untitledPattern.includes("{n}") ? raw.untitledPattern : d.untitledPattern,
    clickableLinks: raw.clickableLinks !== false,
    showRuler: raw.showRuler !== false,
    rulerCol: clampInt(raw.rulerCol, 20, 400, d.rulerCol),
    showLineNumbers: raw.showLineNumbers !== false,
    askWholeDocLineOp: raw.askWholeDocLineOp !== false,
    copyCutWholeLineWhenEmpty: raw.copyCutWholeLineWhenEmpty !== false,
    dragSelectedText: raw.dragSelectedText !== false,
    searchEngine: typeof raw.searchEngine === "string" && /^https?:\/\//i.test(raw.searchEngine.trim()) ? raw.searchEngine.trim() : d.searchEngine,
    showChangeHistory: raw.showChangeHistory !== false,
    syncZoomAcrossSplit: raw.syncZoomAcrossSplit === true,
    windowsTerminalApp: raw.windowsTerminalApp === "cmd" ? "cmd" : "powershell",
    printDefaults: {
      range: printRaw.range === "selection" ? "selection" : "all",
      lineNumbers: printRaw.lineNumbers !== false,
      marginMm: clampInt(printRaw.marginMm, 0, 50, d.printDefaults.marginMm),
      header: typeof printRaw.header === "string" ? printRaw.header : d.printDefaults.header,
      footer: typeof printRaw.footer === "string" ? printRaw.footer : d.printDefaults.footer,
      colorMode: ["wysiwyg", "bw", "inv", "none"].includes(String(printRaw.colorMode))
        ? (printRaw.colorMode as NotepadPrintColorMode)
        : d.printDefaults.colorMode,
    },
  };
}

function readPreferences(): NotepadPreferences {
  try {
    const raw = localStorage.getItem(NOTEPAD_PREFERENCES_KEY);
    if (!raw) {
      const filePrefs = useFileOpenPreferences.getState();
      return validatePreferences({
        ...DEFAULT_NOTEPAD_PREFERENCES,
        wrap: filePrefs.wrap,
        fontSize: filePrefs.fontSize,
      });
    }
    return validatePreferences(JSON.parse(raw) as Partial<NotepadPreferences>);
  } catch {
    return { ...DEFAULT_NOTEPAD_PREFERENCES, printDefaults: { ...DEFAULT_NOTEPAD_PREFERENCES.printDefaults } };
  }
}

export const useNotepadPreferences = create<NotepadPreferences>(() => readPreferences());

export function setNotepadPreferences(patch: Partial<NotepadPreferences>): void {
  const next = validatePreferences({ ...useNotepadPreferences.getState(), ...patch });
  try {
    localStorage.setItem(NOTEPAD_PREFERENCES_KEY, JSON.stringify(next));
  } catch {
    // Ignore storage quota errors.
  }
  useNotepadPreferences.setState(next, true);
  if (patch.wrap !== undefined || patch.fontSize !== undefined) {
    const sharedPatch: { wrap?: boolean; fontSize?: number } = {};
    if (patch.wrap !== undefined) sharedPatch.wrap = next.wrap;
    if (patch.fontSize !== undefined) sharedPatch.fontSize = Math.max(10, Math.min(32, next.fontSize));
    setFileOpenPreferences(sharedPatch);
  }
}

export function resetNotepadPreferences(): void {
  const next = validatePreferences({ ...DEFAULT_NOTEPAD_PREFERENCES });
  try {
    localStorage.removeItem(NOTEPAD_PREFERENCES_KEY);
  } catch {
    // Ignore storage errors.
  }
  useNotepadPreferences.setState(next, true);
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === NOTEPAD_PREFERENCES_KEY || event.key === null) {
      useNotepadPreferences.setState(readPreferences(), true);
    }
  });
}
