import { ContextMenu, type MenuItem } from "../ContextMenu";
import { useLocale } from "../../lib/i18n";
import { NOTEPAD_COMMAND_BY_ID, commandLabel } from "../../lib/notepad/commands/catalog";
import { formatShortcutDisplay, useNotepadKeymap } from "../../lib/notepad/commands/keymap";

/** Editor context-menu request raised by NotepadCodeMirrorPane on right click. */
export interface NotepadContextMenuRequest {
  x: number;
  y: number;
  paneIndex: 0 | 1;
}

export interface NotepadContextMenuProps {
  request: NotepadContextMenuRequest | null;
  readOnly: boolean;
  /** Whether the active editor pane currently has a text selection. */
  hasSelection: boolean;
  onCommand: (commandId: string) => void;
  onClose: () => void;
}

interface NotepadContextMenuEntry {
  commandId: string;
  testId: string;
}

const SEPARATOR = "separator" as const;

/**
 * Design §3.3 order: clipboard/history, line edits, find/replace, bookmarks,
 * then path/save actions. Every row executes through the command registry so
 * shortcuts, read-only guards and macro recording stay in one place.
 */
const CONTEXT_MENU_LAYOUT: ReadonlyArray<NotepadContextMenuEntry | typeof SEPARATOR> = [
  { commandId: "edit.undo", testId: "notepad-context-undo" },
  { commandId: "edit.redo", testId: "notepad-context-redo" },
  SEPARATOR,
  { commandId: "edit.cut", testId: "notepad-context-cut" },
  { commandId: "edit.copy", testId: "notepad-context-copy" },
  { commandId: "edit.paste", testId: "notepad-context-paste" },
  { commandId: "edit.pasteSpecial", testId: "notepad-context-paste-special" },
  { commandId: "edit.delete", testId: "notepad-context-delete" },
  { commandId: "edit.selectAll", testId: "notepad-context-select-all" },
  SEPARATOR,
  { commandId: "edit.duplicateLine", testId: "notepad-context-duplicate-line" },
  { commandId: "edit.deleteLine", testId: "notepad-context-delete-line" },
  { commandId: "edit.moveLineUp", testId: "notepad-context-move-line-up" },
  { commandId: "edit.moveLineDown", testId: "notepad-context-move-line-down" },
  SEPARATOR,
  { commandId: "search.find", testId: "notepad-context-find" },
  { commandId: "search.findNext", testId: "notepad-context-find-next" },
  { commandId: "search.replace", testId: "notepad-context-replace" },
  { commandId: "search.goToLine", testId: "notepad-context-go-to" },
  SEPARATOR,
  { commandId: "search.toggleBookmark", testId: "notepad-context-toggle-bookmark" },
  SEPARATOR,
  { commandId: "edit.copyCurrentFilePath", testId: "notepad-context-copy-path" },
  { commandId: "file.save", testId: "notepad-context-save" },
  { commandId: "file.saveAs", testId: "notepad-context-save-as" },
];

/** Commands that leave the file content untouched and stay enabled read-only. */
const READ_ONLY_ALLOWED = new Set<string>([
  "edit.copy",
  "edit.selectAll",
  "edit.copyCurrentFilePath",
  "search.find",
  "search.findNext",
  "search.replace",
  "search.goToLine",
  "search.toggleBookmark",
  "file.saveAs",
]);

function itemDisabled(commandId: string, readOnly: boolean, hasSelection: boolean): boolean {
  // Delete removes the selection only; with an empty selection the command is a
  // documented no-op, so keep it disabled instead of offering a dead row.
  if (commandId === "edit.delete" && !hasSelection) return true;
  if (!readOnly) return false;
  return !READ_ONLY_ALLOWED.has(commandId);
}

function buildContextMenuItems({
  locale,
  readOnly,
  hasSelection,
  resolveShortcut,
  onCommand,
}: {
  locale: string;
  readOnly: boolean;
  hasSelection: boolean;
  resolveShortcut: (commandId: string) => string;
  onCommand: (commandId: string) => void;
}): MenuItem[] {
  return CONTEXT_MENU_LAYOUT.map((entry) => {
    if (entry === SEPARATOR) return { label: "", separator: true };
    const definition = NOTEPAD_COMMAND_BY_ID.get(entry.commandId);
    const shortcut = formatShortcutDisplay(resolveShortcut(entry.commandId));
    return {
      label: definition ? commandLabel(definition, locale) : entry.commandId,
      testId: entry.testId,
      shortcut: shortcut || undefined,
      disabled: itemDisabled(entry.commandId, readOnly, hasSelection),
      onClick: () => onCommand(entry.commandId),
    };
  });
}

/**
 * App-style editor context menu (U3). Rendered through the shared ContextMenu so
 * QA's `assert_menu_items` / `click_menu` verbs (root test id `context-menu`)
 * work the same as for every other Taomni context menu. Rows keep dedicated
 * `notepad-context-*` test ids because they are a Notepad-specific contract.
 */
export function NotepadContextMenu(props: NotepadContextMenuProps) {
  if (!props.request) return null;
  return <NotepadContextMenuSurface {...props} request={props.request} />;
}

function NotepadContextMenuSurface({
  request,
  readOnly,
  hasSelection,
  onCommand,
  onClose,
}: NotepadContextMenuProps & { request: NotepadContextMenuRequest }) {
  const { locale } = useLocale();
  const resolveShortcut = useNotepadKeymap((state) => state.resolveShortcut);
  // Re-render when the user remaps a shortcut so the menu shows fresh labels.
  useNotepadKeymap((state) => state.overrides);
  const items = buildContextMenuItems({ locale, readOnly, hasSelection, resolveShortcut, onCommand });
  return <ContextMenu items={items} x={request.x} y={request.y} onClose={onClose} />;
}
