/**
 * Cross-component registry for live terminal panels.
 *
 * Each `TerminalPanel` registers itself on mount with:
 *   - `tabId`: the owning tab's id (canonical key the rest of the app uses)
 *   - `sessionId`: the backend terminal session id for write_terminal IPC
 *   - `getBufferText`: returns the entire scrollback as plain text
 *   - `getLastLines(n)`: returns the last N lines of the active buffer
 *   - `writeInput(data)`: forwards text to the terminal stdin (base64-encoded
 *     by the underlying writeTerminal call)
 *
 * Consumers (the AI Chat Drawer being the primary one) look up the registered
 * entry by `tabId` to either pull terminal context for `@terminal:last-N`
 * resolution or push commands the assistant suggested into the live terminal
 * via the "Send to terminal" button on rendered code blocks.
 *
 * The registry lives on `globalThis` so it survives Vite HMR remounts; React
 * components register on mount and unregister on unmount. We deliberately do
 * NOT make it a Zustand store: tracking xterm refs in React state triggers
 * extra renders for every keystroke. A plain Map is the right primitive.
 */

export interface TerminalRegistryEntry {
  tabId: string;
  sessionId: string;
  /** Title shown in the global chat picker ("global chat ↔ terminal X"). */
  title: string;
  /** Full scrollback as plain text. */
  getBufferText: () => string;
  /** Last `n` non-wrapped lines as plain text. */
  getLastLines: (n: number) => string;
  /** Write text to the terminal's stdin (newlines flow as-is). */
  writeInput: (data: string) => void;
}

interface TerminalRegistryShape {
  entries: Map<string, TerminalRegistryEntry>;
  activeTabId: string | null;
}

const KEY = "__newmob_terminal_registry__";

function ensureRegistry(): TerminalRegistryShape {
  const g = globalThis as unknown as Record<string, unknown>;
  let reg = g[KEY] as TerminalRegistryShape | undefined;
  if (!reg) {
    reg = { entries: new Map(), activeTabId: null };
    g[KEY] = reg;
  }
  return reg;
}

export function registerTerminal(entry: TerminalRegistryEntry): () => void {
  const reg = ensureRegistry();
  reg.entries.set(entry.tabId, entry);
  return () => {
    const cur = ensureRegistry();
    const existing = cur.entries.get(entry.tabId);
    // Only remove if the registered entry is still ours — guards against
    // race conditions where StrictMode double-mounts a panel and the unmount
    // fires after the second mount has overwritten the entry.
    if (existing && existing.sessionId === entry.sessionId) {
      cur.entries.delete(entry.tabId);
    }
  };
}

/** Mark the tab whose terminal panel currently has focus / is the active tab. */
export function setActiveTerminalTab(tabId: string | null): void {
  ensureRegistry().activeTabId = tabId;
}

export function getActiveTerminalTabId(): string | null {
  return ensureRegistry().activeTabId;
}

export function getTerminal(tabId: string | null | undefined): TerminalRegistryEntry | null {
  if (!tabId) return null;
  return ensureRegistry().entries.get(tabId) ?? null;
}

export function getActiveTerminal(): TerminalRegistryEntry | null {
  const reg = ensureRegistry();
  return reg.activeTabId ? reg.entries.get(reg.activeTabId) ?? null : null;
}

export function listTerminals(): TerminalRegistryEntry[] {
  return Array.from(ensureRegistry().entries.values());
}
