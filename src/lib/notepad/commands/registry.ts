import { NOTEPAD_COMMAND_BY_ID } from "./catalog";
import type {
  NotepadCommandArgs,
  NotepadCommandHandler,
  RecordedMacroStep,
} from "./types";

export type MacroRecordListener = (step: RecordedMacroStep) => void;

export class NotepadCommandRegistry {
  private readonly handlers = new Map<string, NotepadCommandHandler>();
  private readonly recordListeners = new Set<MacroRecordListener>();

  register(commandId: string, handler: NotepadCommandHandler): () => void {
    if (!NOTEPAD_COMMAND_BY_ID.has(commandId)) {
      throw new Error(`Unknown Notepad command id: ${commandId}`);
    }
    this.handlers.set(commandId, handler);
    return () => {
      if (this.handlers.get(commandId) === handler) {
        this.handlers.delete(commandId);
      }
    };
  }

  registerMany(entries: Record<string, NotepadCommandHandler>): () => void {
    const unsubs = Object.entries(entries).map(([id, fn]) => this.register(id, fn));
    return () => unsubs.forEach((fn) => fn());
  }

  onRecordStep(listener: MacroRecordListener): () => void {
    this.recordListeners.add(listener);
    return () => this.recordListeners.delete(listener);
  }

  isRecordable(commandId: string): boolean {
    return NOTEPAD_COMMAND_BY_ID.get(commandId)?.recordable === true;
  }

  recordTextInsert(text: string): void {
    if (!text) return;
    for (const listener of this.recordListeners) {
      listener({ type: "insertText", text });
    }
  }

  async execute(
    commandId: string,
    args?: NotepadCommandArgs,
    options?: { skipRecord?: boolean },
  ): Promise<boolean> {
    const handler = this.handlers.get(commandId);
    if (!handler) return false;
    await handler(args);
    if (!options?.skipRecord && this.isRecordable(commandId)) {
      for (const listener of this.recordListeners) {
        listener({ type: "command", commandId, args });
      }
    }
    return true;
  }

  hasHandler(commandId: string): boolean {
    return this.handlers.has(commandId);
  }
}
