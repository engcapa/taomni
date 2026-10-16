// @vitest-environment node
// Capability prototype only. Headless timing is NOT packaged-WebView performance evidence.
import { describe, expect, it } from "vitest";
import headless from "@xterm/headless";
import serialize from "@xterm/addon-serialize";
import type { Terminal as BrowserTerminal } from "@xterm/xterm";
const { Terminal } = headless;
const { SerializeAddon } = serialize;
const write = (term: InstanceType<typeof Terminal>, data: string | Uint8Array) =>
  new Promise<void>((resolve) => term.write(data, resolve));
function screen(term: InstanceType<typeof Terminal>) {
  const buffer = term.buffer.active;
  return Array.from({ length: term.rows }, (_, row) => buffer.getLine(buffer.baseY + row)?.translateToString(true));
}
function create(cols = 80, rows = 24) {
  const terminal = new Terminal({ cols, rows, scrollback: 10000, allowProposedApi: true });
  const addon = new SerializeAddon();
  terminal.loadAddon(addon as unknown as Parameters<BrowserTerminal["loadAddon"]>[0]);
  return { terminal, addon };
}
describe("public xterm6 / SerializeAddon 0.14 capability prototype", () => {
  for (const [cols, rows] of [[80, 24], [160, 50], [240, 80], [400, 80]]) {
    it(`serializes bounded normal screen/history and subsequent display at ${cols}x${rows}`, async () => {
      const source = create(cols, rows);
      const restored = create(cols, rows);
      try {
        await write(source.terminal, Array.from({ length: 1200 }, (_, i) => `row-${i} 中文🙂\r\n`).join("") + "\x1b[31mPROMPT> \x1b[0m");
        const snapshot = source.addon.serialize({ scrollback: 500 });
        expect(snapshot).not.toContain("row-0 ");
        await write(restored.terminal, snapshot);
        expect(restored.terminal.buffer.active.length).toBeLessThanOrEqual(500 + rows);
        expect(screen(restored.terminal)).toEqual(screen(source.terminal));
        expect(restored.terminal.buffer.active.cursorX).toBe(source.terminal.buffer.active.cursorX);
        expect(restored.terminal.buffer.active.cursorY).toBe(source.terminal.buffer.active.cursorY);
        await write(source.terminal, "next\r\n");
        await write(restored.terminal, "next\r\n");
        expect(screen(restored.terminal)).toEqual(screen(source.terminal));
      } finally { source.terminal.dispose(); restored.terminal.dispose(); }
    });
  }
  it("replays complete alternate screen and publicly reported input modes", async () => {
    const source = create();
    const restored = create();
    try {
      await write(source.terminal, "shell\r\n\x1b[?1049h\x1b[?1h\x1b[?2004h\x1b[?1000h\x1b[5;9Hvim 中文");
      await write(restored.terminal, source.addon.serialize({ scrollback: 500 }));
      expect(restored.terminal.buffer.active.type).toBe("alternate");
      expect(screen(restored.terminal)).toEqual(screen(source.terminal));
      expect(restored.terminal.modes).toEqual(source.terminal.modes);
      await write(source.terminal, "\x1b[?1049l");
      await write(restored.terminal, "\x1b[?1049l");
      expect(screen(restored.terminal)).toEqual(screen(source.terminal));
    } finally { source.terminal.dispose(); restored.terminal.dispose(); }
  });
  it("demonstrates that a completed write callback is not a safe CSI snapshot boundary", async () => {
    const source = create();
    const restored = create();
    try {
      await write(source.terminal, "before\x1b[3");
      await write(restored.terminal, source.addon.serialize({ scrollback: 500 }));
      await write(source.terminal, "1mAFTER");
      await write(restored.terminal, "1mAFTER");
      expect(screen(restored.terminal)).not.toEqual(screen(source.terminal));
    } finally { source.terminal.dispose(); restored.terminal.dispose(); }
  });
  it("demonstrates an incomplete UTF8 boundary cannot be restored from serialization alone", async () => {
    const source = create();
    const restored = create();
    try {
      const bytes = new TextEncoder().encode("中文");
      await write(source.terminal, bytes.slice(0, 2));
      await write(restored.terminal, source.addon.serialize({ scrollback: 500 }));
      await write(source.terminal, bytes.slice(2));
      await write(restored.terminal, bytes.slice(2));
      expect(screen(restored.terminal)).not.toEqual(screen(source.terminal));
    } finally { source.terminal.dispose(); restored.terminal.dispose(); }
  });
  for (const partial of ["\x1b]0;pending-title", "\x1bPpending-dcs"]) {
    it(`rejects treating partial ${partial.startsWith("\x1b]") ? "OSC" : "DCS"} as a proven checkpoint`, async () => {
      const source = create();
      const restored = create();
      try {
        await write(source.terminal, "before" + partial);
        await write(restored.terminal, source.addon.serialize({ scrollback: 500 }));
        await write(source.terminal, "continuation\x1b\\AFTER");
        await write(restored.terminal, "continuation\x1b\\AFTER");
        expect(screen(restored.terminal)).not.toEqual(screen(source.terminal));
      } finally { source.terminal.dispose(); restored.terminal.dispose(); }
    });
  }
  it("preserves a resized complete screen using public dimensions", async () => {
    const source = create();
    const restored = create(160, 50);
    try {
      await write(source.terminal, "中文🙂\r\n\x1b[31mcolor\x1b[0m");
      source.terminal.resize(160, 50);
      await write(restored.terminal, source.addon.serialize({ scrollback: 500 }));
      expect(screen(restored.terminal)).toEqual(screen(source.terminal));
    } finally { source.terminal.dispose(); restored.terminal.dispose(); }
  });
});
