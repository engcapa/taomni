import { create } from "zustand";
import { classifyFile } from "../lib/openFile/classifyFile";
import { documentPathKey, isUntitledKey } from "../lib/openFile/pathIdentity";
import {
  VIEWER_TEXT_CHUNK_SIZE, VIEWER_TEXT_EDIT_LIMIT, VIEWER_TEXT_HARD_LIMIT,
  normalizeViewerText, viewerReadText, viewerReadTextChunk, viewerReleaseTemp, viewerStat,
  viewerTextForDisk, viewerWriteText, type ViewerDocument, type ViewerEol, type ViewerTextData, type ViewerWriteAck,
} from "../lib/viewer";
import { readViewerDrafts, writeViewerDrafts } from "./viewerDrafts";
import { notepadBackupList, notepadBackupRead } from "../lib/notepad/ipc";
import { useNotepadStore } from "./notepadStore";

export interface ViewerCloseRequest { paths: string[]; proceed: () => void; cancel?: () => void }
interface DocumentState {
  documents: Record<string, ViewerDocument>;
  closeRequest?: ViewerCloseRequest;
  draftError?: string;
  open: (path: string, readOnlyReason?: string, forceEdit?: boolean) => Promise<void>;
  createUntitled: (docId: string, options?: { content?: string; encoding?: string; bom?: boolean; eol?: ViewerEol; dirty?: boolean }) => ViewerDocument;
  edit: (path: string, content: string) => void;
  configure: (path: string, options: { encoding?: string; eol?: ViewerEol; bom?: boolean }) => void;
  setEditorReadOnly: (path: string, readOnly: boolean) => void;
  applyRestoredBackup: (path: string, backup: { content: string; encoding?: string; bom?: boolean; eol?: ViewerEol; savedHash?: string }) => void;
  rekey: (oldPath: string, newPath: string, ack: ViewerWriteAck, options?: { encoding?: string; bom?: boolean; eol?: ViewerEol; content?: string }) => void;
  save: (path: string) => Promise<void>;
  reload: (path: string, encoding?: string) => Promise<void>;
  checkExternal: (path: string) => Promise<void>;
  keepMine: (path: string) => void;
  discard: (path: string) => void;
  readChunk: (path: string, offset: number) => Promise<void>;
  release: (path: string) => void;
  flushDrafts: () => void;
}
const opening = new Map<string, Promise<void>>();
const saving = new Map<string, Promise<void>>();
const checking = new Map<string, number>();
const generations = new Map<string, number>();
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

function emptyDocument(path: string, readOnlyReason?: string): ViewerDocument {
  const untitled = isUntitledKey(path);
  return {
    key: documentPathKey(path), path, kind: untitled ? "text" : classifyFile(path),
    content: "", savedContent: "", savedHash: "",
    encoding: "UTF-8", savedEncoding: "UTF-8", bom: false, savedBom: false, eol: "LF", savedEol: "LF", originalLineEndings: [],
    dirty: false, mtime: 0, size: 0, readOnly: !!readOnlyReason, readOnlyReason,
    loading: !untitled, saving: false, large: false, truncated: false, revision: 0, chunkOffset: 0, nextOffset: 0, eof: true,
  };
}
function fromDisk(previous: ViewerDocument, data: ViewerTextData): ViewerDocument {
  return {
    ...previous, content: normalizeViewerText(data.content), savedContent: normalizeViewerText(data.content),
    savedHash: data.hash, encoding: data.encoding, savedEncoding: data.encoding, bom: data.bom, savedBom: data.bom,
    eol: data.eol, savedEol: data.eol, originalLineEndings: data.content.match(/\r\n|\r|\n/g) ?? [],
    mtime: data.mtime, size: data.size, dirty: false, loading: false, error: undefined, external: undefined,
    truncated: data.truncated, eof: !data.truncated, restored: false, revision: previous.revision + 1,
  };
}
function isDirty(document: ViewerDocument): boolean {
  if (isUntitledKey(document.key)) {
    return document.content.length > 0 || document.content !== document.savedContent
      || document.encoding !== document.savedEncoding || document.eol !== document.savedEol || document.bom !== document.savedBom;
  }
  return document.content !== document.savedContent || document.encoding !== document.savedEncoding
    || document.eol !== document.savedEol || document.bom !== document.savedBom;
}

export const useDocumentStore = create<DocumentState>((set, get) => {
  const update = (path: string, change: (document: ViewerDocument) => ViewerDocument) => set((state) => {
    const key = documentPathKey(path);
    const current = state.documents[key];
    return current ? { documents: { ...state.documents, [key]: change(current) } } : state;
  });
  return {
    documents: {},
    createUntitled(docId, options) {
      const key = documentPathKey(docId);
      const existing = get().documents[key];
      if (existing) return existing;
      const content = normalizeViewerText(options?.content ?? "");
      const encoding = options?.encoding ?? "UTF-8";
      const bom = options?.bom ?? false;
      const eol = options?.eol ?? "LF";
      const doc: ViewerDocument = {
        ...emptyDocument(key),
        content,
        savedContent: options?.dirty ? "" : content,
        encoding,
        savedEncoding: encoding,
        bom,
        savedBom: bom,
        eol,
        savedEol: eol,
        dirty: options?.dirty ?? content.length > 0,
        loading: false,
      };
      set((state) => ({ documents: { ...state.documents, [key]: doc } }));
      return doc;
    },
    open(path, readOnlyReason, forceEdit = false) {
      const key = documentPathKey(path);
      if (isUntitledKey(key)) {
        if (!get().documents[key]) get().createUntitled(key);
        return Promise.resolve();
      }
      const pending = opening.get(key);
      if (pending) return pending;
      const existing = get().documents[key];
      if (existing && !existing.error && !forceEdit) return Promise.resolve();
      const generation = (generations.get(key) ?? 0) + 1;
      generations.set(key, generation);
      const task = (async () => {
        const initial = existing ?? emptyDocument(path, readOnlyReason);
        set((state) => ({ documents: { ...state.documents, [key]: { ...initial, loading: true, error: undefined } } }));
        try {
          const stat = await viewerStat(path);
          if (!stat.isFile) throw new Error("not_file: Not a regular file");
          const large = stat.size > VIEWER_TEXT_EDIT_LIMIT;
          if (forceEdit && stat.size > VIEWER_TEXT_HARD_LIMIT) throw new Error("too_large: Editing is limited to 20 MB");
          if (initial.kind === "image") {
            if (generations.get(key) === generation) update(path, (document) => ({ ...document, ...stat, loading: false }));
            return;
          }
          const data = await viewerReadText(path, large && !forceEdit ? VIEWER_TEXT_CHUNK_SIZE : VIEWER_TEXT_HARD_LIMIT);
          if (generations.get(key) !== generation) return;
          let document = fromDisk(initial, data);
          if (forceEdit && data.truncated) throw new Error("too_large: File grew beyond the 20 MB editing limit");
          document = { ...document, large: (large || data.truncated) && !forceEdit, readOnly: !!readOnlyReason || data.truncated || (large && !forceEdit), readOnlyReason,
            nextOffset: data.nextOffset ?? (data.truncated ? VIEWER_TEXT_CHUNK_SIZE : stat.size) };
          let draft = !readOnlyReason && !document.large ? readViewerDrafts()[key] : undefined;
          if (!readOnlyReason && !document.large && document.kind === "text") {
            try {
              const backups = await notepadBackupList();
              const match = backups.find((b) => b.docId === key || (b.path && documentPathKey(b.path) === key));
              if (match) {
                const loaded = await notepadBackupRead(match.id);
                if (generations.get(key) !== generation) return;
                const eol = loaded.entry.eol === "CRLF" || loaded.entry.eol === "CR" ? loaded.entry.eol : "LF";
                document = {
                  ...document,
                  content: normalizeViewerText(loaded.content),
                  savedHash: loaded.entry.savedHash || data.hash,
                  encoding: loaded.entry.encoding || document.encoding,
                  bom: loaded.entry.bom,
                  eol,
                  dirty: true,
                  restored: true,
                  external: loaded.entry.savedHash && loaded.entry.savedHash !== data.hash ? data : undefined,
                };
                useNotepadStore.getState().patchDoc(key, { backupState: "saved", lastBackupAt: loaded.entry.updatedAt * 1000 });
                draft = undefined;
              }
            } catch {
              // Fallback to localStorage draft if backup IPC is unavailable
            }
          }
          if (draft) {
            document = { ...document, ...draft, key, path, dirty: true, restored: true,
              external: draft.savedHash !== data.hash ? data : undefined };
          }
          set((state) => ({ documents: { ...state.documents, [key]: document } }));
        } catch (error) {
          if (generations.get(key) === generation) update(path, (document) => ({ ...document, loading: false, error: message(error) }));
        }
      })();
      opening.set(key, task);
      void task.finally(() => { if (opening.get(key) === task) opening.delete(key); });
      return task;
    },
    edit(path, content) {
      update(path, (document) => {
        if (document.readOnly || document.loading) return document;
        const next = { ...document, content: normalizeViewerText(content), revision: document.revision + 1 };
        return { ...next, dirty: isDirty(next) };
      });
      get().flushDrafts();
    },
    configure(path, options) {
      update(path, (document) => {
        if (document.readOnly) return document;
        const next = { ...document, ...options, revision: document.revision + 1 };
        return { ...next, dirty: isDirty(next) };
      });
      get().flushDrafts();
    },
    setEditorReadOnly(path, readOnly) {
      update(path, (document) => {
        if (document.readOnlyReason) return { ...document, readOnly: true };
        return { ...document, readOnly };
      });
    },
    applyRestoredBackup(path, backup) {
      const key = documentPathKey(path);
      const current = get().documents[key];
      const normalized = normalizeViewerText(backup.content);
      if (!current) {
        const doc = get().createUntitled(key, {
          content: normalized,
          encoding: backup.encoding ?? "UTF-8",
          bom: backup.bom ?? false,
          eol: backup.eol ?? "LF",
          dirty: true,
        });
        set((state) => ({
          documents: {
            ...state.documents,
            [key]: { ...doc, restored: true, dirty: true, savedHash: backup.savedHash ?? "" },
          },
        }));
        return;
      }
      update(path, (document) => ({
        ...document,
        content: normalized,
        encoding: backup.encoding ?? document.encoding,
        bom: backup.bom ?? document.bom,
        eol: backup.eol ?? document.eol,
        dirty: true,
        restored: true,
        revision: document.revision + 1,
      }));
    },
    rekey(oldPath, newPath, ack, options) {
      const oldKey = documentPathKey(oldPath);
      const newKey = documentPathKey(newPath);
      const current = get().documents[oldKey];
      if (!current) return;
      generations.set(oldKey, (generations.get(oldKey) ?? 0) + 1);
      generations.set(newKey, (generations.get(newKey) ?? 0) + 1);
      opening.delete(oldKey); saving.delete(oldKey); checking.delete(oldKey);
      const content = options?.content !== undefined ? normalizeViewerText(options.content) : current.content;
      const encoding = options?.encoding ?? current.encoding;
      const bom = options?.bom ?? current.bom;
      const eol = options?.eol ?? current.eol;
      const nextDoc: ViewerDocument = {
        ...current,
        key: newKey,
        path: newPath,
        kind: classifyFile(newPath),
        content,
        savedContent: content,
        savedHash: ack.hash,
        encoding,
        savedEncoding: encoding,
        bom,
        savedBom: bom,
        eol,
        savedEol: eol,
        size: ack.size,
        mtime: ack.mtime,
        dirty: false,
        saving: false,
        loading: false,
        readOnly: false,
        readOnlyReason: undefined,
        error: undefined,
        external: undefined,
        restored: false,
        large: false,
        truncated: false,
        revision: current.revision + 1,
      };
      set((state) => {
        const documents = { ...state.documents };
        if (oldKey !== newKey) delete documents[oldKey];
        documents[newKey] = nextDoc;
        return { documents };
      });
      get().flushDrafts();
    },
    save(path) {
      const key = documentPathKey(path);
      if (isUntitledKey(key)) return Promise.reject(new Error("untitled: Untitled documents must be saved with Save As"));
      const pending = saving.get(key);
      if (pending) return pending;
      const snapshot = get().documents[key];
      if (!snapshot || snapshot.readOnly || snapshot.loading || !snapshot.dirty) return Promise.resolve();
      if (snapshot.external) return Promise.reject(new Error("conflict: Resolve the external change before saving"));
      const generation = (generations.get(key) ?? 0) + 1;
      generations.set(key, generation);
      update(path, (document) => ({ ...document, saving: true, error: undefined }));
      const task = (async () => {
        try {
          const result = await viewerWriteText({ path, content: viewerTextForDisk(snapshot), encoding: snapshot.encoding,
            bom: snapshot.bom, eol: snapshot.eol, expectedHash: snapshot.savedHash });
          if (generations.get(key) !== generation) return;
          update(path, (document) => {
            const next = { ...document, savedContent: snapshot.content, savedHash: result.hash, savedEncoding: snapshot.encoding,
              savedBom: snapshot.bom, savedEol: snapshot.eol, size: result.size, mtime: result.mtime, saving: false, restored: false };
            return { ...next, dirty: isDirty(next) };
          });
          get().flushDrafts();
        } catch (error) {
          if (generations.get(key) === generation) {
            update(path, (document) => ({ ...document, saving: false, error: message(error) }));
            if (/conflict|hash_mismatch/i.test(message(error))) await get().checkExternal(path);
          }
          throw error;
        }
      })();
      saving.set(key, task);
      void task.finally(() => { if (saving.get(key) === task) saving.delete(key); }).catch(() => {});
      return task;
    },
    async reload(path, encoding) {
      const key = documentPathKey(path);
      if (isUntitledKey(key)) return;
      const current = get().documents[key];
      if (!current || current.saving) return;
      const revision = current.revision;
      const generation = (generations.get(key) ?? 0) + 1;
      generations.set(key, generation);
      update(path, (document) => ({ ...document, loading: true }));
      try {
        const data = await viewerReadText(path, current.large ? VIEWER_TEXT_CHUNK_SIZE : VIEWER_TEXT_HARD_LIMIT, encoding);
        if (generations.get(key) !== generation) return;
        update(path, (document) => document.revision !== revision ? { ...document, loading: false, external: data }
          : { ...fromDisk(document, data), chunkOffset: 0, nextOffset: data.nextOffset ?? (data.truncated ? VIEWER_TEXT_CHUNK_SIZE : data.size) });
        get().flushDrafts();
      } catch (error) {
        if (generations.get(key) === generation) update(path, (document) => ({ ...document, loading: false, error: message(error) }));
      }
    },
    async checkExternal(path) {
      const key = documentPathKey(path);
      if (isUntitledKey(key)) return;
      const snapshot = get().documents[key];
      const generation = generations.get(key) ?? 0;
      const initialReadFailed = !!snapshot?.error && !snapshot.savedHash && !snapshot.content;
      if (!snapshot || snapshot.loading || snapshot.saving || snapshot.kind === "image" || snapshot.large || initialReadFailed || checking.get(key) === generation) return;
      checking.set(key, generation);
      try {
        const data = await viewerReadText(path, VIEWER_TEXT_HARD_LIMIT);
        if (generations.get(key) !== generation) return;
        update(path, (document) => {
          if (document.savedHash === data.hash || document.saving) return document;
          return document.dirty ? { ...document, external: data } : fromDisk(document, data);
        });
      } catch (error) {
        if (generations.get(key) === generation) update(path, (document) => ({ ...document, error: message(error) }));
      } finally { if (checking.get(key) === generation) checking.delete(key); }
    },
    keepMine(path) {
      update(path, (document) => {
        if (!document.external) return document;
        const external = document.external;
        const next = { ...document, savedContent: normalizeViewerText(external.content), savedHash: external.hash,
          mtime: external.mtime, external: undefined, error: undefined };
        return { ...next, dirty: isDirty(next) };
      });
      get().flushDrafts();
    },
    discard(path) {
      update(path, (document) => ({ ...document, content: document.savedContent, encoding: document.savedEncoding,
        eol: document.savedEol, bom: document.savedBom, dirty: false, error: undefined, revision: document.revision + 1 }));
      get().flushDrafts();
    },
    async readChunk(path, offset) {
      const current = get().documents[documentPathKey(path)];
      if (!current?.large || current.loading) return;
      const generation = (generations.get(current.key) ?? 0) + 1;
      generations.set(current.key, generation);
      update(path, (document) => ({ ...document, loading: true }));
      try {
        const chunk = await viewerReadTextChunk(path, offset, current.encoding);
        if (generations.get(current.key) !== generation) return;
        update(path, (document) => ({ ...document, content: normalizeViewerText(chunk.content), loading: false,
          chunkOffset: offset, nextOffset: chunk.nextOffset, eof: chunk.eof, revision: document.revision + 1 }));
      } catch (error) {
        if (generations.get(current.key) === generation) update(path, (document) => ({ ...document, loading: false, error: message(error) }));
      }
    },
    release(path) {
      const key = documentPathKey(path);
      generations.set(key, (generations.get(key) ?? 0) + 1);
      get().flushDrafts();
      opening.delete(key);
      saving.delete(key);
      checking.delete(key);
      const current = get().documents[key];
      if (current?.readOnlyReason) void viewerReleaseTemp(path).catch(() => {});
      set((state) => { const documents = { ...state.documents }; delete documents[key]; return { documents }; });
    },
    flushDrafts() {
      try { writeViewerDrafts(get().documents); if (get().draftError) set({ draftError: undefined }); }
      catch (error) { set({ draftError: `Draft recovery storage failed: ${message(error)}` }); }
    },
  };
});
