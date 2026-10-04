import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCREENSHOT_OPEN_FAILED_EVENT, type ShortcutStatus } from "./screenshot";
import {
  DEFAULT_SCREENSHOT_SHORTCUT,
  screenshotShortcutLabel,
  useScreenshotAppShortcut,
  useScreenshotShortcutStore,
} from "./screenshotShortcut";

const mocks = vi.hoisted(() => ({
  native: false,
  windowLabel: "main",
  invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  listen: vi.fn(),
  unlisten: vi.fn(),
  dialogs: { alert: vi.fn() },
}));

vi.mock("./runtime", () => ({
  getAppPlatform: () => "windows",
  isTauriRuntime: () => mocks.native,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: mocks.windowLabel, listen: mocks.listen }),
}));
vi.mock("./appDialogs", async (importOriginal) => ({
  ...await importOriginal<typeof import("./appDialogs")>(),
  useAppDialogs: () => mocks.dialogs,
}));

const fallback: ShortcutStatus = {
  accelerator: "Control+Alt+A",
  defaultAccelerator: "Control+Alt+A",
  enabled: true,
  registered: false,
  error: null,
};
const chord = { code: "KeyA", ctrlKey: true, altKey: true };

beforeEach(() => {
  mocks.native = false;
  mocks.windowLabel = "main";
  mocks.invoke.mockReset().mockImplementation(async (command) =>
    command === "screenshot_shortcut_status" ? { ...fallback } : undefined,
  );
  mocks.listen.mockReset().mockResolvedValue(mocks.unlisten);
  mocks.unlisten.mockReset();
  mocks.dialogs.alert.mockReset().mockResolvedValue(undefined);
  useScreenshotShortcutStore.setState({ status: { ...fallback }, loaded: false });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function mountShortcut() {
  const result = renderHook(() => useScreenshotAppShortcut());
  await act(async () => { await Promise.resolve(); });
  return result;
}

const openCalls = () => mocks.invoke.mock.calls.filter(([command]) => command === "screenshot_open_overlay");

// Renderer/store and mocked IPC contracts, not real OS-global registration.
describe("screenshot shortcut store", () => {
  it("loads browser state without querying native IPC", async () => {
    expect(DEFAULT_SCREENSHOT_SHORTCUT).toBe("Control+Alt+A");
    await useScreenshotShortcutStore.getState().refresh();
    expect(useScreenshotShortcutStore.getState().loaded).toBe(true);
    expect(useScreenshotShortcutStore.getState().status).toEqual(fallback);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("updates, disables, and resets the browser chord without native IPC", async () => {
    const store = useScreenshotShortcutStore.getState();
    const custom = await store.update("Control+Shift+KeyQ");
    expect(screenshotShortcutLabel(custom)).toBe("Ctrl+Shift+Q");
    const disabled = await store.update("");
    expect(disabled.enabled).toBe(false);
    expect(screenshotShortcutLabel(disabled)).toBe("");
    const reset = await store.update(null);
    expect(reset).toEqual(fallback);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("refreshes native configured registration status", async () => {
    mocks.native = true;
    const configured = { ...fallback, accelerator: "Alt+F2", registered: true };
    mocks.invoke.mockResolvedValue(configured);
    await useScreenshotShortcutStore.getState().refresh();
    expect(mocks.invoke).toHaveBeenCalledWith("screenshot_shortcut_status");
    expect(useScreenshotShortcutStore.getState()).toMatchObject({ loaded: true, status: configured });
  });

  it("retains fallback state and marks loaded when native refresh fails", async () => {
    mocks.native = true;
    mocks.invoke.mockRejectedValue(new Error("status unavailable"));
    await expect(useScreenshotShortcutStore.getState().refresh()).resolves.toBeUndefined();
    expect(useScreenshotShortcutStore.getState()).toMatchObject({ loaded: true, status: fallback });
  });

  it.each([null, "", "Alt+F2"])("passes native update %j through and stores the returned status", async (accelerator) => {
    mocks.native = true;
    const next = {
      ...fallback,
      accelerator: accelerator ?? fallback.defaultAccelerator,
      enabled: accelerator !== "",
      registered: accelerator !== "",
    };
    mocks.invoke.mockResolvedValue(next);
    await expect(useScreenshotShortcutStore.getState().update(accelerator)).resolves.toEqual(next);
    expect(mocks.invoke).toHaveBeenCalledWith("screenshot_shortcut_set", { accelerator });
    expect(useScreenshotShortcutStore.getState().status).toEqual(next);
  });

  it("propagates native update failure without replacing the previous chord", async () => {
    mocks.native = true;
    mocks.invoke.mockRejectedValue(new Error("registration denied"));
    await expect(useScreenshotShortcutStore.getState().update("Alt+F2")).rejects.toThrow("registration denied");
    expect(useScreenshotShortcutStore.getState().status).toEqual(fallback);
  });
});

describe("useScreenshotAppShortcut", () => {
  it.each([false, true])("opens once for a matching fallback chord (native=%s) and prevents the key event", async (native) => {
    mocks.native = native;
    await mountShortcut();
    const event = new KeyboardEvent("keydown", { ...chord, bubbles: true, cancelable: true });
    fireEvent(document.body, event);
    expect(event.defaultPrevented).toBe(true);
    expect(openCalls()).toEqual([["screenshot_open_overlay", { displayId: null, includeCurrentWindow: false }]]);
  });

  it("does not double-open when native global registration already handles the chord", async () => {
    mocks.native = true;
    const registered = { ...fallback, registered: true };
    mocks.invoke.mockResolvedValue(registered);
    useScreenshotShortcutStore.setState({ status: registered });
    await mountShortcut();
    fireEvent.keyDown(document.body, chord);
    expect(openCalls()).toHaveLength(0);
  });

  it("does not handle a disabled shortcut", async () => {
    useScreenshotShortcutStore.setState({ status: { ...fallback, accelerator: "", enabled: false } });
    await mountShortcut();
    fireEvent.keyDown(document.body, chord);
    expect(openCalls()).toHaveLength(0);
  });

  it.each(["screenshot-overlay", "screenshot-recorder", "screenshot-pin-7", "screenshot-scroll", "screenshot-boundary-0"])("does not handle keys inside %s", async (label) => {
    mocks.native = true;
    mocks.windowLabel = label;
    await mountShortcut();
    fireEvent.keyDown(document.body, chord);
    expect(openCalls()).toHaveLength(0);
  });

  it.each(["input", "textarea", "select", "contenteditable", "editor-child", "terminal-child"])("ignores a matching chord from %s", async (target) => {
    render(
      <main>
        <input data-testid="input" />
        <textarea data-testid="textarea" />
        <select data-testid="select"><option>fixture</option></select>
        <div contentEditable data-testid="contenteditable" />
        <div className="cm-editor"><span data-testid="editor-child" /></div>
        <div className="xterm"><span data-testid="terminal-child" /></div>
      </main>,
    );
    await mountShortcut();
    fireEvent.keyDown(screen.getByTestId(target), chord);
    expect(openCalls()).toHaveLength(0);
  });

  it("ignores repeats, already-prevented events, wrong keys, and extra modifiers", async () => {
    await mountShortcut();
    fireEvent.keyDown(document.body, { ...chord, repeat: true });
    fireEvent.keyDown(document.body, { ...chord, shiftKey: true });
    fireEvent.keyDown(document.body, { ...chord, code: "KeyB" });
    const prevented = new KeyboardEvent("keydown", { ...chord, cancelable: true });
    prevented.preventDefault();
    fireEvent(document.body, prevented);
    expect(openCalls()).toHaveLength(0);
  });

  it("replaces the handler when the chord changes and removes it when disabled or unmounted", async () => {
    const { unmount } = await mountShortcut();
    await act(async () => { await useScreenshotShortcutStore.getState().update("Control+Shift+KeyQ"); });
    fireEvent.keyDown(document.body, chord);
    expect(openCalls()).toHaveLength(0);
    fireEvent.keyDown(document.body, { code: "KeyQ", ctrlKey: true, shiftKey: true });
    expect(openCalls()).toHaveLength(1);
    await act(async () => { await useScreenshotShortcutStore.getState().update(""); });
    fireEvent.keyDown(document.body, { code: "KeyQ", ctrlKey: true, shiftKey: true });
    expect(openCalls()).toHaveLength(1);
    await act(async () => { await useScreenshotShortcutStore.getState().update(null); });
    unmount();
    fireEvent.keyDown(document.body, chord);
    expect(openCalls()).toHaveLength(1);
  });

  it("shows permission instructions when the app shortcut fails", async () => {
    await mountShortcut();
    const error = new Error("capture permission denied");
    mocks.invoke.mockRejectedValueOnce(error);
    fireEvent.keyDown(document.body, chord);
    await waitFor(() => expect(mocks.dialogs.alert).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining(error.message),
      tone: "error",
    })));
  });

  it("shows backend global-shortcut failures even when global registration succeeded", async () => {
    mocks.native = true;
    mocks.invoke.mockResolvedValue({ ...fallback, registered: true });
    const { unmount } = await mountShortcut();
    expect(mocks.listen).toHaveBeenCalledWith(SCREENSHOT_OPEN_FAILED_EVENT, expect.any(Function));
    const handler = mocks.listen.mock.calls[0][1];
    await act(async () => {
      handler({ payload: "Enable Taomni in macOS Screen Recording settings" });
    });
    expect(mocks.dialogs.alert).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("Screen Recording"),
      tone: "error",
    }));
    expect(openCalls()).toHaveLength(0);
    unmount();
    expect(mocks.unlisten).toHaveBeenCalledOnce();
  });

  it("releases an error listener that resolves after unmount", async () => {
    mocks.native = true;
    let resolveListen!: (stop: () => void) => void;
    mocks.listen.mockImplementation(() => new Promise<() => void>((resolve) => { resolveListen = resolve; }));
    const { unmount } = await mountShortcut();
    unmount();
    await act(async () => { resolveListen(mocks.unlisten); });
    expect(mocks.unlisten).toHaveBeenCalledOnce();
  });
});
