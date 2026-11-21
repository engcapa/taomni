export type NotepadCommandCategory =
  | "file"
  | "edit"
  | "search"
  | "view"
  | "encoding"
  | "macro"
  | "tools"
  | "window"
  | "help";

export interface NotepadCommandDefinition {
  id: string;
  titleKey: string;
  defaultLabel: string;
  category: NotepadCommandCategory;
  defaultShortcut?: string;
  macosShortcut?: string;
  /** DEC-07: strict whitelist for macro recording; file I/O, dialogs, settings & external tools are false. */
  recordable: boolean;
}

export interface NotepadCommandArgs {
  text?: string;
  count?: number;
  columnMode?: "text" | "number";
  styleIndex?: 1 | 2 | 3 | 4 | 5;
  encoding?: string;
  eol?: "LF" | "CRLF" | "CR";
  [key: string]: unknown;
}

export type NotepadCommandHandler = (args?: NotepadCommandArgs) => void | Promise<void>;

export interface RecordedMacroStep {
  type: "command" | "insertText";
  commandId?: string;
  args?: NotepadCommandArgs;
  text?: string;
}

export interface ShortcutConflict {
  shortcut: string;
  commandIds: string[];
}
