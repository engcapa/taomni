export type NotepadHostKind = "explorer" | "main" | "workspace";

export interface NotepadHostContext {
  host: NotepadHostKind;
  workspaceId?: string;
}

export interface HostedDocRef {
  tabId: string;
  host: NotepadHostKind;
  workspaceId?: string;
  docKey: string;
  path: string;
  title: string;
  untitled: boolean;
  pinned: boolean;
  dirty: boolean;
}

export interface UntitledOpenOptions {
  title?: string;
  encoding?: string;
  bom?: boolean;
  eol?: "LF" | "CRLF" | "CR";
  dirty?: boolean;
}

export interface NotepadHostAdapter {
  openFile: (path: string, ctx: NotepadHostContext) => Promise<void>;
  openUntitled: (ctx: NotepadHostContext, initialContent?: string, options?: UntitledOpenOptions) => string;
  activateDoc: (docKey: string, ctx?: NotepadHostContext) => boolean;
  closeDoc: (docKey: string, ctx?: NotepadHostContext) => boolean;
  closeMany: (docKeys: string[], options?: { keepPinned?: boolean; host?: NotepadHostKind; workspaceId?: string }) => void;
  listOpenDocs: (ctx?: Partial<NotepadHostContext>) => HostedDocRef[];
  getActiveDoc: (ctx?: Partial<NotepadHostContext>) => HostedDocRef | null;
  rekeyDoc: (oldKey: string, newPath: string, newTitle?: string) => void;
  pinDoc: (docKey: string, pinned?: boolean) => void;
}
