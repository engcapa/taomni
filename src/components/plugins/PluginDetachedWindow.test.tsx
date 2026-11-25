import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "../../types";
import { writeDetachedHandoff } from "../../lib/detachedSession";
import { deferred } from "../../lib/tests/pluginFrontendHarness";
import { useAppStore } from "../../stores/appStore";
import { usePluginFrontendStore } from "../../stores/pluginFrontendStore";
import { PluginDetachedWindow } from "./PluginDetachedWindow";

const mocks = vi.hoisted(() => ({ native: vi.fn(), onClose: vi.fn(), close: vi.fn(), publish: vi.fn(),
  attach: vi.fn(), detach: vi.fn(), unlisten: vi.fn() }));
vi.mock("../../lib/runtime", () => ({ isTauriRuntime: mocks.native }));
vi.mock("../../lib/i18n", async (original) => ({ ...await original<object>(), useT: () => (key: string) => key }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onCloseRequested: mocks.onClose }) }));
vi.mock("../../lib/detachWindowing", () => ({ closeCurrentDetachedWindow: mocks.close }));
vi.mock("../../lib/detachedSession", async (original) => ({ ...await original<object>(), broadcastReattach: mocks.publish }));
vi.mock("./PluginTabPane", () => ({ PluginTabPane: ({ tab }: { tab: Tab }) => <div data-testid="module-pane">{tab.id}</div> }));

const tab: Tab = { id: "plugin-detached-test", type: "plugin", title: "Hello", closable: true,
  plugin: { slug: "hello-plugin", kind: "hello-plugin" } };
const originalAttach = usePluginFrontendStore.getState().attach;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  mocks.native.mockReturnValue(true);
  mocks.attach.mockReturnValue(mocks.detach);
  mocks.onClose.mockResolvedValue(mocks.unlisten);
  mocks.close.mockResolvedValue(undefined);
  usePluginFrontendStore.setState({ attach: mocks.attach });
  useAppStore.setState({ tabs: [], activeTabId: null });
  writeDetachedHandoff("plugin", tab.id, tab);
});
afterEach(() => { cleanup(); usePluginFrontendStore.setState({ attach: originalAttach }); vi.restoreAllMocks(); });

describe("independent module WebView lifecycle", () => {
  it("initializes its registry, restores a sanitized locator on reload and cleans its listener", async () => {
    const view = render(<PluginDetachedWindow id={tab.id} />);
    expect(screen.getByTestId("module-pane")).toHaveTextContent(tab.id);
    expect(useAppStore.getState().tabs).toEqual([tab]);
    expect(mocks.attach).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mocks.onClose).toHaveBeenCalledTimes(1));
    view.unmount();
    expect(mocks.detach).toHaveBeenCalledTimes(1);
    expect(mocks.unlisten).toHaveBeenCalledTimes(1);
    expect(mocks.publish).not.toHaveBeenCalled();
    localStorage.clear();
    render(<PluginDetachedWindow id={tab.id} />);
    expect(screen.getByTestId("module-pane")).toHaveTextContent(tab.id);
  });

  it("prevents native close, broadcasts the original identity once and relinquishes the source view", async () => {
    render(<PluginDetachedWindow id={tab.id} />);
    await waitFor(() => expect(mocks.onClose).toHaveBeenCalledTimes(1));
    const event = { preventDefault: vi.fn() };
    await act(async () => mocks.onClose.mock.calls[0][0](event));
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(mocks.publish).toHaveBeenCalledExactlyOnceWith("plugin", tab.id, tab);
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("module-pane")).toBeNull();
  });

  it("keeps only the main view active if OS close fails and retries close without a duplicate reattach", async () => {
    mocks.close.mockRejectedValueOnce(new Error("close failed"));
    render(<PluginDetachedWindow id={tab.id} />);
    fireEvent.click(screen.getByTestId("plugin-tab-reattach"));
    expect(await screen.findByRole("alert")).toHaveTextContent("close failed");
    expect(screen.queryByTestId("module-pane")).toBeNull();
    expect(screen.getByTestId("plugin-tab-returned")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("plugin-tab-reattach"));
    await waitFor(() => expect(mocks.close).toHaveBeenCalledTimes(2));
    expect(mocks.publish).toHaveBeenCalledTimes(1);
  });

  it("unlistens a registration that completes after teardown", async () => {
    const registration = deferred<() => void>();
    mocks.onClose.mockReturnValueOnce(registration.promise);
    const view = render(<PluginDetachedWindow id={tab.id} />);
    view.unmount();
    await act(async () => registration.resolve(mocks.unlisten));
    expect(mocks.unlisten).toHaveBeenCalledTimes(1);
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("does not reattach on browser reload and rejects a different locator identity", () => {
    mocks.native.mockReturnValue(false);
    const view = render(<PluginDetachedWindow id={tab.id} />);
    fireEvent(window, new Event("pagehide"));
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.onClose).not.toHaveBeenCalled();
    view.unmount();
    writeDetachedHandoff("plugin", "plugin-other", tab);
    render(<PluginDetachedWindow id="plugin-other" />);
    expect(screen.queryByTestId("module-pane")).toBeNull();
    expect(screen.getByTestId("plugin-tab-reattach")).toBeDisabled();
  });
});
