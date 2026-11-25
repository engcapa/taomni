import type { ReactNode } from "react";
import {
  CircleDot,
  Clipboard,
  Columns2,
  Copy,
  FilePlus,
  FolderOpen,
  FolderSearch,
  Link2,
  Map,
  Pilcrow,
  Play,
  Printer,
  Redo2,
  Replace,
  Save,
  SaveAll,
  Scissors,
  Search,
  Square,
  Undo2,
  WrapText,
} from "lucide-react";
import { useViewerLabels } from "../viewer/viewerLabels";
import "./notepad-toolbar-statusbar.css";

function NotepadToolButton({
  testId,
  legacyTestId,
  title,
  command,
  pressed = false,
  toggle = false,
  recording = false,
  hasRecordedBuffer,
  disabled = false,
  onCommand,
  children,
}: {
  testId: string;
  legacyTestId?: string;
  title: string;
  command: string;
  pressed?: boolean;
  toggle?: boolean;
  recording?: boolean;
  hasRecordedBuffer?: boolean;
  disabled?: boolean;
  onCommand: (commandId: string) => void;
  children: ReactNode;
}) {
  const className = `np-tool-btn${pressed ? " active" : ""}${recording ? " rec" : ""}`;
  return (
    <button
      type="button"
      className={className}
      data-testid={testId}
      data-active={pressed ? "true" : undefined}
      data-has-buffer={hasRecordedBuffer === undefined ? undefined : hasRecordedBuffer ? "true" : "false"}
      aria-pressed={toggle ? pressed : undefined}
      disabled={disabled}
      title={title}
      onClick={() => onCommand(command)}
    >
      {legacyTestId ? (
        <span className="np-tool-icon" data-testid={legacyTestId}>
          {children}
        </span>
      ) : (
        children
      )}
    </button>
  );
}

export function NotepadToolbar({
  dirty,
  readOnly,
  saving,
  wrap,
  allSymbols,
  split,
  panels,
  recordingMacro,
  syncScroll = false,
  hasRecordedBuffer = false,
  onCommand,
}: {
  dirty: boolean;
  readOnly: boolean;
  large: boolean;
  saving: boolean;
  wrap: boolean;
  allSymbols: boolean;
  split: boolean;
  panels: { minimap: boolean; doclist: boolean; chars: boolean };
  recordingMacro: boolean;
  syncScroll?: boolean;
  hasRecordedBuffer?: boolean;
  disabled?: boolean;
  onCommand: (commandId: string) => void;
}) {
  const label = useViewerLabels();

  return (
    <div className="np-toolbar" role="toolbar" aria-label="Notepad Toolbar" data-testid="notepad-toolbar">
      {/* File group */}
      <NotepadToolButton testId="notepad-tool-new" title={label("新建", "New")} command="file.new" onCommand={onCommand}>
        <FilePlus size={15} />
      </NotepadToolButton>
      <NotepadToolButton testId="notepad-tool-open" title={label("打开", "Open")} command="file.open" onCommand={onCommand}>
        <FolderOpen size={15} />
      </NotepadToolButton>
      <NotepadToolButton
        testId="viewer-save"
        title={label("保存", "Save")}
        command="file.save"
        disabled={!dirty || readOnly || saving}
        onCommand={onCommand}
      >
        <Save size={15} />
      </NotepadToolButton>
      <NotepadToolButton
        testId="notepad-tool-saveall"
        legacyTestId="notepad-tool-save-all"
        title={label("全部保存", "Save All")}
        command="file.saveAll"
        onCommand={onCommand}
      >
        <SaveAll size={15} />
      </NotepadToolButton>

      <span className="np-tool-sep" />

      {/* Undo / redo group */}
      <NotepadToolButton testId="notepad-tool-undo" title={label("撤销", "Undo")} command="edit.undo" onCommand={onCommand}>
        <Undo2 size={15} />
      </NotepadToolButton>
      <NotepadToolButton testId="notepad-tool-redo" title={label("重做", "Redo")} command="edit.redo" onCommand={onCommand}>
        <Redo2 size={15} />
      </NotepadToolButton>

      <span className="np-tool-sep" />

      {/* Clipboard group */}
      <NotepadToolButton testId="notepad-tool-cut" title={label("剪切", "Cut")} command="edit.cut" onCommand={onCommand}>
        <Scissors size={15} />
      </NotepadToolButton>
      <NotepadToolButton testId="notepad-tool-copy" title={label("复制", "Copy")} command="edit.copy" onCommand={onCommand}>
        <Copy size={15} />
      </NotepadToolButton>
      <NotepadToolButton testId="notepad-tool-paste" title={label("粘贴", "Paste")} command="edit.paste" onCommand={onCommand}>
        <Clipboard size={15} />
      </NotepadToolButton>

      <span className="np-tool-sep" />

      {/* Search group */}
      <NotepadToolButton testId="notepad-tool-find" title={label("查找", "Find")} command="search.find" onCommand={onCommand}>
        <Search size={15} />
      </NotepadToolButton>
      <NotepadToolButton testId="notepad-tool-replace" title={label("替换", "Replace")} command="search.replace" onCommand={onCommand}>
        <Replace size={15} />
      </NotepadToolButton>
      <NotepadToolButton
        testId="notepad-tool-find-files"
        title={label("在文件中查找", "Find in Files")}
        command="search.findInFiles"
        onCommand={onCommand}
      >
        <FolderSearch size={15} />
      </NotepadToolButton>

      <span className="np-tool-sep" />

      {/* View toggles group */}
      <NotepadToolButton
        testId="notepad-tool-wrap"
        title={label("自动换行", "Word Wrap")}
        command="view.wordWrap"
        pressed={wrap}
        toggle
        onCommand={onCommand}
      >
        <WrapText size={15} />
      </NotepadToolButton>
      <NotepadToolButton
        testId="notepad-tool-symbols"
        title={label("显示全部符号", "Show All Symbols")}
        command="view.showAllSymbols"
        pressed={allSymbols}
        toggle
        onCommand={onCommand}
      >
        <Pilcrow size={15} />
      </NotepadToolButton>
      <NotepadToolButton
        testId="notepad-tool-docmap"
        title={label("文档地图", "Document Map")}
        command="view.toggleDocMap"
        pressed={panels.minimap}
        toggle
        onCommand={onCommand}
      >
        <Map size={15} />
      </NotepadToolButton>

      <span className="np-tool-sep" />

      {/* Split group */}
      <NotepadToolButton
        testId="notepad-tool-split"
        title={label("分屏（标签内）", "Split (in Tab)")}
        command="view.toggleSplit"
        pressed={split}
        toggle
        onCommand={onCommand}
      >
        <Columns2 size={15} />
      </NotepadToolButton>
      <NotepadToolButton
        testId="notepad-tool-sync-scroll"
        title={label("同步滚动", "Sync Scroll")}
        command="view.toggleSyncV"
        pressed={syncScroll}
        toggle
        onCommand={onCommand}
      >
        <Link2 size={15} />
      </NotepadToolButton>

      <span className="np-tool-sep" />

      {/* Macro group */}
      <NotepadToolButton
        testId="notepad-tool-macro-record"
        title={label("录制宏", "Record Macro")}
        command="macro.toggleRecord"
        pressed={recordingMacro}
        toggle
        recording={recordingMacro}
        onCommand={onCommand}
      >
        <CircleDot size={15} />
      </NotepadToolButton>
      <NotepadToolButton testId="notepad-tool-macro-stop" title={label("停止", "Stop")} command="macro.stopRecord" onCommand={onCommand}>
        <Square size={15} fill="currentColor" />
      </NotepadToolButton>
      <NotepadToolButton
        testId="notepad-tool-macro-play"
        title={label("回放", "Playback")}
        command="macro.playbackOnce"
        hasRecordedBuffer={hasRecordedBuffer}
        onCommand={onCommand}
      >
        <Play size={15} fill="currentColor" />
      </NotepadToolButton>

      <span className="np-tool-sep" />

      {/* Print */}
      <NotepadToolButton testId="notepad-tool-print" title={label("打印", "Print")} command="file.print" onCommand={onCommand}>
        <Printer size={15} />
      </NotepadToolButton>
    </div>
  );
}
