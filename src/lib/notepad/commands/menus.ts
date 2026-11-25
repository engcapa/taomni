/**
 * Declarative Notepad menu tree.
 *
 * This is pure data: the menu bar renderer walks it, resolves every command id
 * through `NOTEPAD_COMMAND_BY_ID`, and renders labels with `commandLabel(def,
 * locale)` plus the live keymap accelerator. The order, grouping, submenus and
 * separators follow the high-fidelity prototype's nine top-level menus
 * (文件 / 编辑 / 搜索 / 视图 / 编码 / 工具 / 宏 / 对比 / 窗口); there is no
 * help menu — `help.about` stays registered in the catalog but is not shown.
 *
 * Dynamic sections are dedicated nodes rendered from runtime state:
 * - `recentFiles`: 文件 → 最近文件 (MRU list + open all / clear actions)
 * - `savedMacros`: 宏 → saved macro list (or a disabled empty placeholder)
 * - `documents`: 窗口 → open Notepad documents (host tabs, active marker)
 */

export type NotepadMenuNode =
  | { type: "command"; id: string; shortcut?: boolean }
  | { type: "separator" }
  | { type: "submenu"; key: string; zhLabel: string; enLabel: string; items: NotepadMenuNode[] }
  | { type: "recentFiles" }
  | { type: "savedMacros" }
  | { type: "documents" };

export interface NotepadTopMenu {
  id: string;
  zhLabel: string;
  enLabel: string;
  items: NotepadMenuNode[];
}

const separator: NotepadMenuNode = { type: "separator" };

/** Menu item bound to a catalog command; `shortcut: false` hides the accelerator column. */
const command = (id: string, shortcut?: boolean): NotepadMenuNode =>
  shortcut === false ? { type: "command", id, shortcut: false } : { type: "command", id };

const submenu = (
  key: string,
  zhLabel: string,
  enLabel: string,
  items: NotepadMenuNode[],
): NotepadMenuNode => ({ type: "submenu", key, zhLabel, enLabel, items });

const recentFiles: NotepadMenuNode = { type: "recentFiles" };
const savedMacros: NotepadMenuNode = { type: "savedMacros" };
const documents: NotepadMenuNode = { type: "documents" };

export const NOTEPAD_MENUS: readonly NotepadTopMenu[] = [
  {
    id: "file",
    zhLabel: "文件",
    enLabel: "File",
    items: [
      command("file.new"),
      command("file.open"),
      recentFiles,
      command("window.reopenClosedTab"),
      separator,
      command("file.save"),
      command("file.saveAs"),
      command("file.saveCopy"),
      command("file.saveAll"),
      command("file.rename"),
      command("file.moveToTrash"),
      command("file.reload"),
      separator,
      submenu("session", "会话", "Session", [
        command("file.sessionSave"),
        command("file.sessionLoad"),
        separator,
        command("file.backupBrowser"),
      ]),
      command("file.openWith"),
      submenu("external", "在外部打开", "Open in External", [
        command("file.openExternalDefault"),
        command("file.showInFileManager"),
        command("file.openTerminalDir"),
      ]),
      separator,
      command("file.print"),
      command("file.printNow"),
      separator,
      command("file.close"),
      command("file.closeAll"),
      submenu("close-batch", "批量关闭", "Batch Close", [
        command("file.closeOthers"),
        command("file.closeUnpinned"),
        command("file.closeLeft"),
        command("file.closeRight"),
        command("file.closeUnmodified"),
      ]),
    ],
  },
  {
    id: "edit",
    zhLabel: "编辑",
    enLabel: "Edit",
    items: [
      command("edit.undo"),
      command("edit.redo"),
      separator,
      command("edit.cut"),
      command("edit.copy"),
      command("edit.paste"),
      command("edit.pasteSpecial"),
      command("edit.clipboardHistory"),
      command("edit.delete"),
      command("edit.selectAll"),
      separator,
      submenu("select", "选择", "Selection", [
        command("edit.beginEndSelect"),
        command("edit.selectNextOccurrence"),
      ]),
      submenu("insert", "插入", "Insert", [
        command("edit.insertDateTimeShort", false),
        command("edit.insertDateTimeLong"),
        command("edit.insertDateTimeCustom"),
        separator,
        command("edit.columnEditor"),
      ]),
      submenu("line-ops", "行操作", "Line Operations", [
        command("edit.duplicateLine"),
        command("edit.moveLineUp"),
        command("edit.moveLineDown"),
        command("edit.joinLines"),
        command("edit.splitLines", false),
        command("edit.insertBlankLineAbove"),
        command("edit.insertBlankLineBelow"),
        separator,
        submenu("sort", "排序", "Sort", [
          command("edit.sortAsc"),
          command("edit.sortDesc"),
          command("edit.sortCaseInsensitiveAsc"),
          command("edit.sortCiDesc"),
          command("edit.sortLocaleAsc"),
          command("edit.sortLocaleDesc"),
          command("edit.sortNumAsc"),
          command("edit.sortNumDesc"),
          command("edit.sortDecimalCommaAsc"),
          command("edit.sortDecimalCommaDesc"),
          command("edit.sortDecimalDotAsc"),
          command("edit.sortDecimalDotDesc"),
          command("edit.sortLenAsc"),
          command("edit.sortLenDesc"),
        ]),
        separator,
        command("edit.removeDuplicateLines"),
        command("edit.removeConsecutiveDuplicates"),
        command("edit.removeEmptyLines"),
        command("edit.removeBlankLines"),
        command("edit.reverseLines"),
        command("edit.shuffleLines"),
      ]),
      submenu("case", "大小写转换", "Case Conversion", [
        command("edit.toUpperCase"),
        command("edit.toLowerCase"),
        command("edit.toTitleCase"),
        command("edit.toTitleCaseKeep"),
        command("edit.toSentenceCase"),
        command("edit.toSentenceCaseKeep"),
        command("edit.invertCase"),
        command("edit.toRandomCase"),
      ]),
      submenu("whitespace", "空白操作", "White Space Operations", [
        command("edit.trimTrailing"),
        command("edit.trimLeading"),
        command("edit.trimBoth"),
        command("edit.tabsToSpaces"),
        command("edit.spacesToTabsAll"),
        command("edit.spacesToLeadingTabs"),
        command("edit.eolCollapseToSpace"),
      ]),
      separator,
      command("edit.toggleOverwrite"),
      command("edit.toggleVirtualSpace"),
      command("file.toggleReadonly"),
      command("file.toggleAllReadonly"),
      command("file.toggleReadonlyAttr"),
      command("edit.toggleChangeHistory"),
    ],
  },
  {
    id: "search",
    zhLabel: "搜索",
    enLabel: "Search",
    items: [
      command("search.find"),
      command("search.replace"),
      command("search.findInFiles"),
      separator,
      command("search.findNext"),
      command("search.findPrev"),
      command("search.selectAndFind"),
      command("search.selectAndFindVolatile"),
      command("search.incremental"),
      separator,
      command("search.findAllCurrent"),
      command("search.findAllOpen"),
      command("search.replaceAllOpen"),
      command("view.toggleSearchResults"),
      separator,
      command("search.markDialog"),
      submenu("token-styles", "令牌样式", "Token Styles", [
        command("search.styleToken1"),
        command("search.styleTokenClear1"),
        command("search.styleToken2"),
        command("search.styleTokenClear2"),
        command("search.styleToken3"),
        command("search.styleTokenClear3"),
        command("search.styleToken4"),
        command("search.styleTokenClear4"),
        command("search.styleToken5"),
        command("search.styleTokenClear5"),
      ]),
      command("search.clearAllStyles"),
      separator,
      command("search.goToLine"),
      submenu("bookmarks", "书签", "Bookmarks", [
        command("search.toggleBookmark"),
        command("search.nextBookmark"),
        command("search.prevBookmark"),
        command("search.clearBookmarks"),
        separator,
        command("search.cutBookmarkedLines"),
        command("search.copyBookmarkedLines"),
        command("edit.pasteReplaceBookmarkedLines"),
        command("search.removeBookmarkedLines"),
        command("search.removeUnmarkedLines"),
        command("search.inverseBookmarks"),
      ]),
      submenu("change-history", "变更历史", "Change History", [
        command("search.nextChange"),
        command("search.prevChange"),
        command("search.clearChangeHistory"),
      ]),
    ],
  },
  {
    id: "view",
    zhLabel: "视图",
    enLabel: "View",
    items: [
      command("view.toggleSplit"),
      command("view.clonePane"),
      command("view.rotateSplit"),
      command("view.toggleSyncV"),
      separator,
      command("view.wordWrap", false),
      submenu("symbols", "显示符号", "Show Symbols", [
        command("view.showWhitespace"),
        command("view.showTab"),
        command("view.showEol"),
        command("view.showNonPrinting"),
        command("view.indentGuide"),
        separator,
        command("view.showAllSymbols"),
      ]),
      command("view.toggleLineNumbers"),
      command("view.toggleRuler"),
      submenu("zoom", "缩放", "Zoom", [
        command("view.zoomIn"),
        command("view.zoomOut"),
        command("view.zoomReset"),
      ]),
      separator,
      command("view.toggleDocMap"),
      command("view.toggleDocList"),
      command("view.toggleCharPanel"),
      separator,
      command("view.fullscreen"),
      command("view.postIt"),
      command("view.distractionFree"),
      separator,
      command("view.toggleMenubar"),
      command("view.toggleToolbar"),
      command("view.toggleStatusbar"),
      command("view.toggleTheme"),
      separator,
      command("file.summary"),
    ],
  },
  {
    id: "encoding",
    zhLabel: "编码",
    enLabel: "Encoding",
    items: [
      command("encoding.openPicker"),
      separator,
      command("edit.convertEolCrlf"),
      command("edit.convertEolLf"),
      command("edit.convertEolCr"),
    ],
  },
  {
    id: "tools",
    zhLabel: "工具",
    enLabel: "Tools",
    items: [
      command("tools.hashDialog"),
      submenu("tools-convert", "MIME / 进制转换", "MIME / Encoding Conversions", [
        command("tools.mimeBase64Encode"),
        command("tools.mimeBase64Decode"),
        command("tools.mimeUrlEncode"),
        command("tools.mimeUrlDecode"),
      ]),
      command("view.toggleCharPanel"),
      separator,
      command("tools.redactBlock"),
      command("tools.redactDot"),
      separator,
      submenu("selection-actions", "选区动作", "Selection Actions", [
        command("tools.openSelectionPath"),
        command("tools.openSelectionFolder"),
        command("tools.searchSelection"),
      ]),
      submenu("path-info", "复制路径信息", "Copy Path Info", [
        command("edit.copyCurrentFilePath"),
        command("edit.copyCurrentFileName"),
        command("edit.copyDirectoryPath"),
        command("edit.copyAllOpenPaths"),
      ]),
      separator,
      command("tools.preferences"),
      command("tools.shortcutMapper"),
    ],
  },
  {
    id: "macro",
    zhLabel: "宏",
    enLabel: "Macro",
    items: [
      command("macro.toggleRecord"),
      command("macro.stopRecord"),
      command("macro.playbackOnce"),
      command("macro.runMultiple"),
      command("macro.saveCurrent"),
      separator,
      savedMacros,
      separator,
      command("macro.manage"),
      command("tools.validateMacros"),
    ],
  },
  {
    id: "compare",
    zhLabel: "对比",
    enLabel: "Compare",
    items: [
      command("tools.compareOther"),
      command("tools.compareDisk"),
      command("tools.compareClipboard"),
    ],
  },
  {
    id: "window",
    zhLabel: "窗口",
    enLabel: "Window",
    items: [
      command("window.togglePinTab"),
      separator,
      command("view.toggleDocList"),
      separator,
      documents,
    ],
  },
];
