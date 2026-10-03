import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScreenshotProbe, ShortcutStatus } from "../../lib/screenshot";
import { useScreenshotShortcutStore } from "../../lib/screenshotShortcut";
import { ScreenshotSettings } from "./ScreenshotSettings";

const mocks = vi.hoisted(() => ({
  native: false,
  invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  translate: (key: string, params?: Record<string, string | number>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}));

vi.mock("../../lib/runtime", () => ({
  getAppPlatform: () => "windows",
  isTauriRuntime: () => mocks.native,
}));
vi.mock("../../lib/i18n", () => ({ useT: () => mocks.translate }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main" }) }));

const fallback: ShortcutStatus = {
  accelerator: "Control+Alt+A",
  defaultAccelerator: "Control+Alt+A",
  enabled: true,
  registered: false,
  error: null,
};
const probe: ScreenshotProbe = {
  permission: "granted",
  controlPermission: "notRequired",
  mp4Available: true,
  ocrAvailable: true,
  summary: "Unit capability response",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  mocks.native = false;
  mocks.invoke.mockReset().mockImplementation(async (command) => {
    if (command === "screenshot_shortcut_status") return { ...fallback };
    if (command === "screenshot_probe") return { ...probe };
    return undefined;
  });
  useScreenshotShortcutStore.setState({ status: { ...fallback }, loaded: false });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function renderSettings() {
  const view = render(<ScreenshotSettings />);
  await waitFor(() => expect(useScreenshotShortcutStore.getState().loaded).toBe(true));
  return view;
}

// Mounted renderer/store contracts with fake IPC replies only. These do not
// establish real shortcut registration, permissions, or capture capability.
describe("ScreenshotSettings", () => {
  it("shows the browser fallback chord and app-only status without native probing", async () => {
    await renderSettings();
    expect(screen.getByTestId("settings-screenshot-shortcut")).toHaveTextContent("Ctrl+Alt+A");
    expect(screen.getByTestId("settings-screenshot-shortcut-status")).toHaveTextContent("settings.screenshotStatusAppOnly");
    expect(screen.queryByTestId("settings-screenshot-probe")).not.toBeInTheDocument();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("records physical key codes, ignoring modifier-only keys", async () => {
    await renderSettings();
    const button = screen.getByTestId("settings-screenshot-shortcut");
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(button).toHaveTextContent("settings.screenshotPressKeys");
    fireEvent.keyDown(button, { key: "Control", code: "ControlLeft", ctrlKey: true });
    expect(button).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(button, { key: "Dead", code: "KeyQ", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(button).toHaveTextContent("Ctrl+Shift+Q"));
    expect(useScreenshotShortcutStore.getState().status.accelerator).toBe("Control+Shift+KeyQ");
    expect(button).toHaveAttribute("aria-pressed", "false");
  });

  it("rejects an unmodified or Shift-only letter but accepts a function key", async () => {
    await renderSettings();
    const button = screen.getByTestId("settings-screenshot-shortcut");
    fireEvent.click(button);
    fireEvent.keyDown(button, { key: "q", code: "KeyQ" });
    expect(screen.getByTestId("settings-screenshot-shortcut-error")).toHaveTextContent("settings.screenshotNeedsModifier");
    expect(button).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(button, { key: "Q", code: "KeyQ", shiftKey: true });
    expect(useScreenshotShortcutStore.getState().status).toEqual(fallback);
    fireEvent.keyDown(button, { key: "F8", code: "F8" });
    await waitFor(() => expect(button).toHaveTextContent("F8"));
    expect(useScreenshotShortcutStore.getState().status.accelerator).toBe("F8");
    expect(screen.queryByTestId("settings-screenshot-shortcut-error")).not.toBeInTheDocument();
  });

  it.each(["escape", "blur"])("cancels chord capture on %s without updating the configured chord", async (cancel) => {
    await renderSettings();
    const button = screen.getByTestId("settings-screenshot-shortcut");
    fireEvent.click(button);
    if (cancel === "escape") fireEvent.keyDown(button, { key: "Escape", code: "Escape" });
    else fireEvent.blur(button);
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(button).toHaveTextContent("Ctrl+Alt+A");
    expect(useScreenshotShortcutStore.getState().status).toEqual(fallback);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("prevents a captured chord from bubbling to app keyboard handlers", async () => {
    await renderSettings();
    const appHandler = vi.fn();
    window.addEventListener("keydown", appHandler);
    try {
      const button = screen.getByTestId("settings-screenshot-shortcut");
      fireEvent.click(button);
      const event = new KeyboardEvent("keydown", { key: "q", code: "KeyQ", ctrlKey: true, bubbles: true, cancelable: true });
      fireEvent(button, event);
      expect(event.defaultPrevented).toBe(true);
      expect(appHandler).not.toHaveBeenCalled();
      await waitFor(() => expect(button).toHaveTextContent("Ctrl+Q"));
    } finally {
      window.removeEventListener("keydown", appHandler);
    }
  });

  it("disables the shortcut and resets to the default", async () => {
    await renderSettings();
    fireEvent.click(screen.getByTestId("settings-screenshot-shortcut-disable"));
    await waitFor(() => expect(screen.getByTestId("settings-screenshot-shortcut-disable")).toBeDisabled());
    expect(screen.getByTestId("settings-screenshot-shortcut")).toHaveTextContent("settings.screenshotDisabled");
    expect(screen.getByTestId("settings-screenshot-shortcut-status")).toHaveTextContent("settings.screenshotStatusDisabled");
    expect(useScreenshotShortcutStore.getState().status.enabled).toBe(false);
    fireEvent.click(screen.getByTestId("settings-screenshot-shortcut-reset"));
    await waitFor(() => expect(screen.getByTestId("settings-screenshot-shortcut")).toHaveTextContent("Ctrl+Alt+A"));
    expect(useScreenshotShortcutStore.getState().status).toEqual(fallback);
    expect(screen.getByTestId("settings-screenshot-shortcut-disable")).toBeEnabled();
  });

  it.each([true, false])("shows native registered=%s status and capability response", async (registered) => {
    mocks.native = true;
    const status = { ...fallback, registered, error: registered ? null : "chord owned by another app" };
    mocks.invoke.mockImplementation(async (command) => command === "screenshot_probe" ? probe : status);
    await renderSettings();
    expect(await screen.findByTestId("settings-screenshot-probe")).toHaveTextContent(probe.summary);
    expect(screen.getByTestId("settings-screenshot-shortcut-status")).toHaveTextContent(
      registered ? "settings.screenshotStatusGlobal" : "settings.screenshotStatusFallback",
    );
    if (!registered) expect(screen.getByTestId("settings-screenshot-shortcut-status")).toHaveTextContent("chord owned by another app");
    expect(mocks.invoke).toHaveBeenCalledWith("screenshot_shortcut_status");
    expect(mocks.invoke).toHaveBeenCalledWith("screenshot_probe");
  });

  it("keeps the settings usable when native status and probe fail", async () => {
    mocks.native = true;
    mocks.invoke.mockRejectedValue(new Error("bridge unavailable"));
    await renderSettings();
    expect(screen.getByTestId("settings-screenshot-shortcut")).toHaveTextContent("Ctrl+Alt+A");
    expect(screen.getByTestId("settings-screenshot-shortcut-status")).toHaveTextContent("settings.screenshotStatusFallback");
    expect(screen.queryByTestId("settings-screenshot-probe")).not.toBeInTheDocument();
  });

  it.each(["resolve", "reject"])("shows the pending native chord until update %s", async (completion) => {
    mocks.native = true;
    const updated = deferred<ShortcutStatus>();
    mocks.invoke.mockImplementation(async (command) => {
      if (command === "screenshot_shortcut_status") return fallback;
      if (command === "screenshot_probe") return probe;
      if (command === "screenshot_shortcut_set") return updated.promise;
      return undefined;
    });
    await renderSettings();
    const button = screen.getByTestId("settings-screenshot-shortcut");
    fireEvent.click(button);
    fireEvent.keyDown(button, { key: "q", code: "KeyQ", altKey: true });
    expect(button).toHaveTextContent("Alt+Q");
    expect(useScreenshotShortcutStore.getState().status).toEqual(fallback);
    expect(mocks.invoke).toHaveBeenCalledWith("screenshot_shortcut_set", { accelerator: "Alt+KeyQ" });
    await act(async () => {
      if (completion === "resolve") updated.resolve({ ...fallback, accelerator: "Alt+KeyQ", registered: true });
      else updated.reject(new Error("registration rejected"));
    });
    if (completion === "resolve") {
      expect(button).toHaveTextContent("Alt+Q");
      expect(screen.getByTestId("settings-screenshot-shortcut-status")).toHaveTextContent("settings.screenshotStatusGlobal");
    } else {
      expect(button).toHaveTextContent("Ctrl+Alt+A");
      expect(screen.getByRole("alert")).toHaveTextContent("registration rejected");
      expect(useScreenshotShortcutStore.getState().status).toEqual(fallback);
    }
  });
});
