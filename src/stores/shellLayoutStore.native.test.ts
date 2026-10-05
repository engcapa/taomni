import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultShellLayout, SHELL_LAYOUT_KEY } from "../lib/shell/shellLayoutPersistence";

const native = vi.hoisted(() => ({ record: null as string | null, readError: false, writeError: false, writes: 0 }));
vi.mock("../lib/runtime", () => ({ isTauriRuntime: () => true }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async (command: string, args?: { layout: string; expectedLayout: string | null }) => {
  if (command === "load_shell_layout") {
    if (native.readError) throw new Error("Database unreadable");
    return native.record;
  }
  if (command === "save_shell_layout" && args) {
    native.writes++;
    if (native.writeError) throw new Error("Disk full");
    if (args.expectedLayout !== native.record) throw new Error("SHELL_LAYOUT_CHANGED");
    native.record = args.layout;
  }
}) }));

const layoutAt = (width: number) => JSON.stringify({ ...defaultShellLayout(), navigator: { ...defaultShellLayout().navigator, width } });
async function store() { return (await import("./shellLayoutStore")).useShellLayoutStore; }

describe("Desktop layout restore and flush", () => {
  beforeEach(() => {
    vi.resetModules(); vi.useFakeTimers(); localStorage.clear();
    Object.assign(native, { record: null, readError: false, writeError: false, writes: 0 });
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it("restores the acknowledged layout when WebView storage lost the last resize", async () => {
    native.record = layoutAt(232); localStorage.setItem(SHELL_LAYOUT_KEY, layoutAt(200));
    const shell = await store(); await shell.getState().initialize();
    expect(shell.getState().layout.navigator.width).toBe(232);
    expect(JSON.parse(localStorage.getItem(SHELL_LAYOUT_KEY)!).navigator.width).toBe(232);
    expect(shell.getState().warning).toBeNull();
  });

  it("imports an existing localStorage profile only when no desktop record exists", async () => {
    localStorage.setItem(SHELL_LAYOUT_KEY, layoutAt(312));
    const shell = await store(); await shell.getState().initialize();
    expect(JSON.parse(native.record!).navigator.width).toBe(312);
    shell.getState().updateLayout((layout) => ({ ...layout, navigator: { ...layout.navigator, width: 232 } }));
    await shell.getState().flushDurable();
    expect(JSON.parse(native.record!).navigator.width).toBe(232);
  });

  it.each(["{", '{"version":999,"sentinel":"preserve"}'])("preserves unreadable native input %s until Reset", async (raw) => {
    native.record = raw; localStorage.setItem(SHELL_LAYOUT_KEY, layoutAt(312));
    const shell = await store(); await shell.getState().initialize();
    expect(shell.getState().writable).toBe(false);
    await shell.getState().flushDurable();
    expect(native.record).toBe(raw); expect(native.writes).toBe(0);
    expect(localStorage.getItem(SHELL_LAYOUT_KEY)).toBe(layoutAt(312));
    shell.getState().resetLayout(); await shell.getState().flushDurable();
    expect(JSON.parse(native.record!).navigator.width).toBe(248);
  });

  it("preserves invalid local input even when a known durable record exists", async () => {
    native.record = layoutAt(232); localStorage.setItem(SHELL_LAYOUT_KEY, '{"version":999}');
    const shell = await store(); await shell.getState().initialize();
    expect(shell.getState().writable).toBe(false);
    expect(localStorage.getItem(SHELL_LAYOUT_KEY)).toBe('{"version":999}');
    expect(native.record).toBe(layoutAt(232)); expect(native.writes).toBe(0);
  });

  it("reports a disk failure and can retry saving the same layout", async () => {
    const shell = await store(); await shell.getState().initialize();
    native.writeError = true;
    shell.getState().updateLayout((layout) => ({ ...layout, navigator: { ...layout.navigator, width: 232 } }));
    await expect(shell.getState().flushDurable()).rejects.toThrow("Disk full");
    expect(shell.getState().warning).toBe("write");
    native.writeError = false; await shell.getState().flushDurable();
    expect(JSON.parse(native.record!).navigator.width).toBe(232);
    expect(shell.getState().warning).toBeNull();
  });

  it("keeps an unread native record untouched and permits explicit recovery after read failure", async () => {
    native.record = layoutAt(232); native.readError = true;
    const shell = await store(); await shell.getState().initialize();
    expect(shell.getState().warning).toBe("read"); expect(shell.getState().writable).toBe(false);
    expect(native.writes).toBe(0);
    native.readError = false; shell.getState().resetLayout(); await shell.getState().flushDurable();
    expect(JSON.parse(native.record!).navigator.width).toBe(248);
  });
});
