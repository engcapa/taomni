import {
  notepadBackupList,
  notepadBackupPrune,
  notepadBackupRead,
  notepadBackupWrite,
  notepadSaveBackupCopy,
  type NotepadBackupContent,
  type NotepadBackupEntry,
} from "../ipc";
import type { NotepadBackupMode } from "../../../stores/notepadPreferences";

export type DocumentBackupState = "idle" | "saving" | "saved" | "error";

export interface BackupDocumentSnapshot {
  docId: string;
  path: string | null;
  name: string;
  content: string;
  encoding: string;
  bom: boolean;
  eol: string;
  savedHash: string;
  dirty: boolean;
}

export class NotepadBackupManager {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private periodicTimer: ReturnType<typeof setInterval> | null = null;
  private onBackupState?: (docId: string, state: DocumentBackupState, error?: string) => void;

  constructor(onBackupState?: (docId: string, state: DocumentBackupState, error?: string) => void) {
    this.onBackupState = onBackupState;
  }

  scheduleDebouncedBackup(snapshot: BackupDocumentSnapshot, delayMs = 300): void {
    const existing = this.timers.get(snapshot.docId);
    if (existing) clearTimeout(existing);
    if (!snapshot.dirty) return;
    const handle = setTimeout(() => {
      this.timers.delete(snapshot.docId);
      void this.flushSnapshot(snapshot);
    }, delayMs);
    this.timers.set(snapshot.docId, handle);
  }

  async flushSnapshot(snapshot: BackupDocumentSnapshot): Promise<NotepadBackupEntry | null> {
    if (!snapshot.dirty) return null;
    this.onBackupState?.(snapshot.docId, "saving");
    try {
      const entry = await notepadBackupWrite({
        docId: snapshot.docId,
        path: snapshot.path,
        name: snapshot.name,
        content: snapshot.content,
        encoding: snapshot.encoding,
        bom: snapshot.bom,
        eol: snapshot.eol,
        savedHash: snapshot.savedHash,
      });
      this.onBackupState?.(snapshot.docId, "saved");
      return entry;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.onBackupState?.(snapshot.docId, "error", msg);
      return null;
    }
  }

  async pruneDoc(docId: string): Promise<void> {
    const existing = this.timers.get(docId);
    if (existing) {
      clearTimeout(existing);
      this.timers.delete(docId);
    }
    try {
      await notepadBackupPrune(docId);
      this.onBackupState?.(docId, "idle");
    } catch {
      // Ignore cleanup errors
    }
  }

  async createSaveBackupCopy(
    sourcePath: string,
    mode: NotepadBackupMode,
    customDir: string,
  ): Promise<string | null> {
    if (mode === "none") return null;
    return notepadSaveBackupCopy({
      sourcePath,
      mode,
      customDir: customDir.trim() || null,
    });
  }

  startPeriodicBackup(
    intervalSec: number,
    collectDirty: () => BackupDocumentSnapshot[],
  ): () => void {
    this.stopPeriodicBackup();
    const ms = Math.max(5, intervalSec) * 1000;
    this.periodicTimer = setInterval(() => {
      for (const snap of collectDirty()) {
        if (snap.dirty) void this.flushSnapshot(snap);
      }
    }, ms);
    return () => this.stopPeriodicBackup();
  }

  stopPeriodicBackup(): void {
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = null;
    }
  }

  dispose(): void {
    this.stopPeriodicBackup();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}

export async function listPendingBackups(): Promise<NotepadBackupEntry[]> {
  return notepadBackupList();
}

export async function loadPendingBackupContent(id: string): Promise<NotepadBackupContent> {
  return notepadBackupRead(id);
}
