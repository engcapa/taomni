import { describe, expect, it, beforeEach } from "vitest";
import {
  registerTerminal,
  setActiveTerminalTab,
  getActiveTerminal,
  getTerminal,
  listTerminals,
} from "./terminalRegistry";

beforeEach(() => {
  // Reset the singleton between tests so leakage from one case doesn't make
  // the next one's "list is empty" assertions flaky.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).__taomni_terminal_registry__;
});

function makeEntry(tabId: string, sessionId: string) {
  let buffer = "";
  return {
    entry: {
      tabId,
      sessionId,
      title: `tab-${tabId}`,
      getBufferText: () => buffer,
      getLastLines: (n: number) => {
        const lines = buffer.split("\n");
        return lines.slice(-n).join("\n");
      },
      writeInput: (data: string) => {
        buffer += data;
      },
    },
    setBuffer: (s: string) => {
      buffer = s;
    },
    getBuffer: () => buffer,
  };
}

describe("terminalRegistry", () => {
  it("registers and unregisters terminals", () => {
    const a = makeEntry("a", "s-a");
    const off = registerTerminal(a.entry);
    expect(listTerminals()).toHaveLength(1);
    expect(getTerminal("a")?.sessionId).toBe("s-a");
    off();
    expect(listTerminals()).toHaveLength(0);
  });

  it("tracks active terminal separately from registration", () => {
    const a = makeEntry("a", "s-a");
    const b = makeEntry("b", "s-b");
    registerTerminal(a.entry);
    registerTerminal(b.entry);
    setActiveTerminalTab("b");
    expect(getActiveTerminal()?.tabId).toBe("b");
    setActiveTerminalTab(null);
    expect(getActiveTerminal()).toBeNull();
  });

  it("only unregisters its own entry on cleanup race", () => {
    // Simulates StrictMode double-mount: panel A mounts, unmounts, then
    // panel A' (same tabId) mounts with a new sessionId. The first
    // unregister should leave A' in place.
    const first = makeEntry("a", "s-1");
    const second = makeEntry("a", "s-2");
    const offFirst = registerTerminal(first.entry);
    registerTerminal(second.entry);
    offFirst();
    expect(getTerminal("a")?.sessionId).toBe("s-2");
  });

  it("getTerminal returns null for unknown ids and null/undefined input", () => {
    expect(getTerminal(null)).toBeNull();
    expect(getTerminal(undefined)).toBeNull();
    expect(getTerminal("does-not-exist")).toBeNull();
  });

  it("getLastLines on a registered entry returns last N lines of buffer", () => {
    const a = makeEntry("a", "s-a");
    a.setBuffer("one\ntwo\nthree\nfour");
    registerTerminal(a.entry);
    expect(getTerminal("a")?.getLastLines(2)).toBe("three\nfour");
  });

  it("writeInput on a registered entry forwards to the panel", () => {
    const a = makeEntry("a", "s-a");
    registerTerminal(a.entry);
    getTerminal("a")?.writeInput("ls\n");
    expect(a.getBuffer()).toBe("ls\n");
  });
});
