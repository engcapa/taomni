import type { EditorView } from "@codemirror/view";
import type { NotepadCommandRegistry } from "../../../lib/notepad/commands/registry";
import type { RecordedMacroStep } from "../../../lib/notepad/commands/types";
import type { NotepadHostContext } from "../../../lib/notepad/host/types";
import type { MacroPlaybackHost } from "../../../lib/notepad/macro/macroManager";
import type { NotepadBackupManager } from "../../../lib/notepad/persistence/backupManager";
import type { NotepadCaseKind } from "../../../lib/notepad/transforms/case";
import type { TextRange, TextTransformResult } from "../../../lib/notepad/transforms/lines";
import type { SortOptions } from "../../../lib/notepad/transforms/sort";
import type { ViewerDocument } from "../../../lib/viewer";
import type { NotepadDocState } from "../../../stores/notepadStore";
import type { NotepadEditModalKind } from "../dialogs/EditToolDialogs";
import type { NotepadLifecycleModal } from "../dialogs/FileLifecycleDialogs";
import type { NotepadMacroModalKind } from "../dialogs/MacroDialogs";
import type { NotepadPickerDialog } from "../dialogs/PickerDialogs";
import type { NotepadSessionModalKind } from "../dialogs/SessionBackupDialogs";
import type { NotepadToolboxKind } from "../dialogs/ToolboxDialogs";

/** State owners injected by the NotepadEditor workbench shell. */
export interface NotepadActionDeps {
  docKey: string;
  document: ViewerDocument;
  docState: NotepadDocState;
  hostCtx: NotepadHostContext;
  backupMgr: NotepadBackupManager;
  effectiveReadOnly: boolean;
  getActiveView: () => EditorView | null;
  onError: (msg: string | null) => void;
  setFindStatus: (msg: string | null) => void;
  setSearchingFiles: (v: boolean) => void;
  setLifecycleModal: (m: NotepadLifecycleModal | null) => void;
  setEditModal: (k: NotepadEditModalKind) => void;
  setPickerModal: (m: NotepadPickerDialog) => void;
  setEncodingOpen: (v: boolean) => void;
  setToolboxKind: (k: NotepadToolboxKind) => void;
  setMacroModal: (k: NotepadMacroModalKind) => void;
  setPrintOpen: (v: boolean) => void;
  setSessionModal: (k: NotepadSessionModalKind) => void;
  setPrefsOpen: (v: boolean) => void;
  setMapperOpen: (v: boolean) => void;
  setAboutOpen: (v: boolean) => void;
}

/** Shared helpers + mutable context available to every command map. */
export interface NotepadActionContext extends NotepadActionDeps {
  registry: NotepadCommandRegistry;
  replaceViewSelection: (view: EditorView | null, nextText: string, onlySelection: boolean) => void;
  applyTransform: (fn: (text: string, range: TextRange) => TextTransformResult) => void;
  applySort: (opts: SortOptions) => void;
  applyCaseOp: (kind: NotepadCaseKind) => void;
  jumpToOffset: (from: number, to?: number) => void;
  runFindDirection: (backward: boolean) => void;
  performSave: () => Promise<void>;
  macroHost: MacroPlaybackHost;
  toRecordedSteps: (steps: Array<{ commandId: string; args?: Record<string, unknown> }>) => RecordedMacroStep[];
  /** Persist an arbitrary text edit against the authoritative document store. */
  editContent: (text: string) => void;
}
