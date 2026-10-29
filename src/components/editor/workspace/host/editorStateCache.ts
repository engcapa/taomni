import { EditorState, StateEffect, Transaction, type Extension } from "@codemirror/state";
import { documentReplacementChange } from "./documentSync";

interface CachedEditorState {
  state: EditorState;
  path: string;
  scrollTop: number;
  scrollLeft: number;
}

/** Per-pane state only; canonical text, shared undo and disk lifetime stay with their owners. */
export class EditorStateCache {
  private readonly entries = new Map<string, CachedEditorState>();
  private characters = 0;

  constructor(private readonly maxEntries = 24, private readonly maxCharacters = 8_000_000) {}

  take(key: string, path: string): CachedEditorState | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.characters -= entry.state.doc.length;
    return entry.path === path ? entry : undefined;
  }

  save(key: string, entry: CachedEditorState): void {
    this.take(key, entry.path);
    if (entry.state.doc.length > this.maxCharacters) return;
    this.entries.set(key, entry);
    this.characters += entry.state.doc.length;
    while (this.entries.size > this.maxEntries || this.characters > this.maxCharacters) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.take(oldest, this.entries.get(oldest)!.path);
    }
  }

  retain(keys: readonly string[] | undefined): void {
    if (!keys) return;
    const retained = new Set(keys);
    for (const [key, entry] of this.entries) {
      if (!retained.has(key)) this.take(key, entry.path);
    }
  }

  clear(): void {
    this.entries.clear();
    this.characters = 0;
  }
}

/** Rebind every extension to current props without losing the file's state fields. */
export function reconfigureCachedEditorState(state: EditorState, text: string, extensions: Extension): EditorState {
  const change = documentReplacementChange(state.doc.toString(), text);
  return state.update({
    ...(change ? { changes: { from: change.from, to: change.to, insert: change.insert } } : {}),
    effects: StateEffect.reconfigure.of(extensions),
    annotations: Transaction.addToHistory.of(false),
  }).state;
}
