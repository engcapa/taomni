import { useState } from "react";
import { useContextMenu, type MenuItem } from "../ContextMenu";
import { NOTEPAD_COMMAND_BY_ID, commandLabel } from "../../lib/notepad/commands/catalog";
import { NOTEPAD_MENUS, type NotepadMenuNode } from "../../lib/notepad/commands/menus";
import { formatShortcutDisplay, useNotepadKeymap } from "../../lib/notepad/commands/keymap";
import { useLocale } from "../../lib/i18n";
import { useViewerLabels } from "../viewer/viewerLabels";

export interface NotepadMenuDocumentList {
  docKey: string;
  title: string;
  active: boolean;
}

export interface NotepadMenuBarProps {
  dirty: boolean;
  readOnly: boolean;
  recordingMacro: boolean;
  recordedSteps?: number;
  hasRecordedBuffer: boolean;
  recentFiles: string[];
  savedMacros: Array<{ name: string; shortcut?: string }>;
  documents: NotepadMenuDocumentList[];
  checks: Record<string, boolean>;
  capabilities: { pinTabs: boolean };
  onCommand: (commandId: string) => void;
  onOpenRecent: (path: string) => void;
  onOpenAllRecent: () => void;
  onClearRecent: () => void;
  onOpenSavedMacro: (name: string) => void;
  onValidateMacros: () => void;
  onActivateDocument: (docKey: string) => void;
}

/** Commands that leave the document unchanged and therefore stay enabled in read-only mode. */
const READ_ONLY_ALLOWED = new Set<string>([
  "edit.copy",
  "edit.selectAll",
  "edit.copyCurrentFilePath",
  "edit.copyCurrentFileName",
  "edit.copyDirectoryPath",
  "edit.copyAllOpenPaths",
  "edit.toggleVirtualSpace",
  "edit.toggleChangeHistory",
  "edit.toggleOverwrite",
  "edit.beginEndSelect",
  "edit.selectNextOccurrence",
  "edit.clipboardHistory",
  "edit.toggleReadonly",
  "edit.toggleReadonlyAttr",
  "edit.toggleAllReadonly",
  "file.toggleReadonly",
  "search.find",
  "search.replace",
  "search.findInFiles",
  "search.findNext",
  "search.findPrev",
  "search.selectAndFind",
  "search.selectAndFindVolatile",
  "search.findAllCurrent",
  "search.findAllOpen",
  "search.goToLine",
  "search.markDialog",
  "search.nextBookmark",
  "search.prevBookmark",
  "search.clearBookmarks",
  "search.nextChange",
  "search.prevChange",
  "search.clearChangeHistory",
  "search.clearAllStyles",
  "search.toggleBookmark",
  "view.*",
  "tools.hashDialog",
  "tools.mimeBase64Encode",
  "tools.mimeBase64Decode",
  "tools.mimeUrlEncode",
  "tools.mimeUrlDecode",
  "tools.openSelectionPath",
  "tools.openSelectionFolder",
  "tools.searchSelection",
  "tools.compareOther",
  "tools.compareDisk",
  "tools.compareClipboard",
  "tools.compareDiff",
  "tools.preferences",
  "tools.shortcutMapper",
]);

function readOnlyBlocked(commandId: string): boolean {
  if (READ_ONLY_ALLOWED.has(commandId)) return false;
  if (READ_ONLY_ALLOWED.has("*")) return false;
  if (commandId.startsWith("view.") || commandId.startsWith("window.") || commandId.startsWith("help.")) return false;
  if (commandId.startsWith("file.")) {
    return ["file.save", "file.saveAs", "file.saveCopy", "file.saveAll", "file.rename", "file.moveToTrash", "file.reload", "file.print", "file.printNow"].includes(commandId);
  }
  if (commandId.startsWith("macro.")) return false;
  if (commandId.startsWith("encoding.")) return false;
  return true;
}

function macroBlocked(commandId: string, hasRecordedBuffer: boolean, recordingMacro: boolean): boolean {
  if (commandId === "macro.saveCurrent" || commandId === "macro.playbackOnce" || commandId === "macro.runMultiple") {
    return recordingMacro || !hasRecordedBuffer;
  }
  if (commandId === "macro.stopRecord") return !recordingMacro;
  return false;
}

export function NotepadMenuBar({
  dirty,
  readOnly,
  recordingMacro,
  recordedSteps = 0,
  hasRecordedBuffer,
  recentFiles,
  savedMacros,
  documents,
  checks,
  capabilities,
  onCommand,
  onOpenRecent,
  onOpenAllRecent,
  onClearRecent,
  onOpenSavedMacro,
  onValidateMacros,
  onActivateDocument,
}: NotepadMenuBarProps) {
  const label = useViewerLabels();
  const { locale } = useLocale();
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const menu = useContextMenu({ onClose: () => setOpenMenuId(null) });
  const resolveShortcut = useNotepadKeymap((s) => s.resolveShortcut);
  useNotepadKeymap((s) => s.overrides);
  
  const commandItem = (id: string): MenuItem => {
    const def = NOTEPAD_COMMAND_BY_ID.get(id);
    const shortcut = formatShortcutDisplay(resolveShortcut(id));
    const disabled =
      readOnly && readOnlyBlocked(id)
        ? true
        : macroBlocked(id, hasRecordedBuffer, recordingMacro)
          ? true
          : id === "window.togglePinTab"
            ? !capabilities.pinTabs
            : id === "file.save"
              ? !dirty
              : false;
    return {
      label: def ? commandLabel(def, locale) : id,
      testId: `notepad-menu-item-${id}`,
      shortcut: shortcut || undefined,
      checked: checks[id],
      disabled,
      onClick: () => onCommand(id),
    };
  };

  const nodesToItems = (nodes: NotepadMenuNode[]): MenuItem[] => {
    const items: MenuItem[] = [];
    for (const node of nodes) {
      if (node.type === "separator") {
        items.push({ label: "", separator: true });
        continue;
      }
      if (node.type === "command") {
        const item = commandItem(node.id);
        if (node.shortcut === false) item.shortcut = undefined;
        items.push(item);
        continue;
      }
      if (node.type === "submenu") {
        items.push({
          label: label(node.zhLabel, node.enLabel),
          testId: `notepad-menu-group-${node.key}`,
          children: nodesToItems(node.items),
        });
        continue;
      }
      if (node.type === "recentFiles") {
        const children: MenuItem[] = recentFiles.length === 0
          ? [{ label: label("（空）", "(empty)"), testId: "notepad-menu-recent-empty", disabled: true }]
          : recentFiles.slice(0, 10).map((path, index) => ({
              label: path,
              testId: `notepad-recent-item-${index}`,
              onClick: () => onOpenRecent(path),
            }));
        children.push({ label: "", separator: true });
        children.push({ label: label("打开全部最近文件", "Open All Recent Files"), testId: "notepad-menu-recent-open-all", disabled: recentFiles.length === 0, onClick: onOpenAllRecent });
        children.push({ label: label("清空最近文件", "Clear Recent Files"), testId: "notepad-menu-recent-clear", disabled: recentFiles.length === 0, onClick: onClearRecent });
        items.push({ label: label("最近文件", "Recent Files"), testId: "notepad-menu-recent-files", children });
        continue;
      }
      if (node.type === "savedMacros") {
        if (savedMacros.length === 0) {
          items.push({ label: label("（还没有已保存的宏）", "(no saved macros yet)"), testId: "notepad-menu-macro-empty", disabled: true });
        } else {
          for (const macro of savedMacros) {
            items.push({
              label: macro.shortcut ? `${macro.name}  [${formatShortcutDisplay(macro.shortcut)}]` : macro.name,
              testId: `notepad-menu-macro-${macro.name}`,
              onClick: () => onOpenSavedMacro(macro.name),
            });
          }
        }
        items.push({ label: "", separator: true });
        items.push({ label: label("校验宏文件", "Validate Macro File"), testId: "notepad-menu-macro-validate", onClick: onValidateMacros });
        continue;
      }
      if (node.type === "documents") {
        if (documents.length === 0) {
          items.push({ label: label("（没有打开的 Notepad 文档）", "(no open Notepad documents)"), disabled: true });
        } else {
          for (const doc of documents) {
            items.push({
              label: `${doc.active ? "● " : ""}${doc.title}`,
              testId: `notepad-menu-document-${doc.docKey}`,
              onClick: () => onActivateDocument(doc.docKey),
            });
          }
        }
      }
    }
    // Collapse duplicated/leading/trailing separators produced by tree assembly.
    const collapsed: MenuItem[] = [];
    for (const item of items) {
      if (item.separator && (collapsed.length === 0 || collapsed[collapsed.length - 1].separator)) continue;
      collapsed.push(item);
    }
    while (collapsed.length > 0 && collapsed[collapsed.length - 1].separator) collapsed.pop();
    return collapsed;
  };

  const openMenuAt = (menuId: string, target: HTMLElement, nodes: NotepadMenuNode[]) => {
    const rect = target.getBoundingClientRect();
    setOpenMenuId(menuId);
    menu.showAt(rect.left, rect.bottom + 2, nodesToItems(nodes));
  };

  return (
    <>
      {menu.render}
      <nav className="np-menubar" aria-label="Notepad Menu Bar" data-testid="notepad-menubar">
        {NOTEPAD_MENUS.map((top) => (
          <button
            key={top.id}
            type="button"
            className="np-menu-trigger"
            data-testid={`notepad-menu-${top.id}`}
            data-open={openMenuId === top.id || undefined}
            onClick={(event) => {
              event.stopPropagation();
              if (openMenuId === top.id) {
                menu.close("programmatic");
                return;
              }
              openMenuAt(top.id, event.currentTarget, top.items);
            }}
            onMouseEnter={(event) => {
              // Prototype: hovering another top-level menu while a menu is open
              // switches to it without an extra click.
              if (openMenuId && openMenuId !== top.id) openMenuAt(top.id, event.currentTarget, top.items);
            }}
          >
            {label(top.zhLabel, top.enLabel)}
          </button>
        ))}
        {recordingMacro && (
          <span className="np-record-chip" data-testid="notepad-menubar-recording">
            {label(`● 录制中 · ${recordedSteps} 步`, `● Recording · ${recordedSteps} steps`)}
          </span>
        )}
      </nav>
    </>
  );
}
