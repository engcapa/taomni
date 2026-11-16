import { memo, useEffect, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "../../types";
import type { PluginFrontendModule } from "../../lib/pluginLoader";
import type { PluginFrontendApi, PluginFrontendProps } from "../../lib/pluginFrontendHost";
import { deferred, moduleRecord } from "../../lib/tests/pluginFrontendHarness";
import { usePluginFrontendStore } from "../../stores/pluginFrontendStore";
import { PluginTabPane } from "./PluginTabPane";

const mocks = vi.hoisted(() => ({ list: vi.fn(), invoke: vi.fn(), cancel: vi.fn().mockResolvedValue(true) }));
vi.mock("../../lib/ipc/plugin", () => ({ listPlugins: mocks.list, invokePlugin: mocks.invoke, cancelPluginRequest: mocks.cancel }));

const tab: Tab = { id: "plugin-test-one", type: "plugin", title: "Hello Plugin", closable: true,
  plugin: { slug: "hello-plugin", kind: "hello-plugin" } };

beforeEach(() => {
  const record = moduleRecord();
  usePluginFrontendStore.setState({ records: { [record.slug]: record }, epochs: {}, pending: new Set(), status: "ready", error: null });
  mocks.list.mockReset().mockResolvedValue([record]);
  mocks.invoke.mockReset().mockResolvedValue({ values: [] });
  mocks.cancel.mockClear();
});
afterEach(cleanup);

describe("real module tab renderer", () => {
  it("retains component state while inactive and cleans effects before disable, then reactivates", async () => {
    const stopped = vi.fn();
    function View() {
      const [value, setValue] = useState("draft");
      useEffect(() => stopped, []);
      return <input aria-label="module draft" value={value} onChange={(event) => setValue(event.target.value)} />;
    }
    const importer = vi.fn().mockResolvedValue({ default: memo(View) });
    const view = render(<PluginTabPane tab={tab} active importer={importer} />);
    fireEvent.change(await screen.findByLabelText("module draft"), { target: { value: "retained draft" } });
    view.rerender(<PluginTabPane tab={tab} active={false} importer={importer} />);
    expect((screen.getByLabelText("module draft") as HTMLInputElement).value).toBe("retained draft");
    expect(stopped).not.toHaveBeenCalled();
    mocks.list.mockResolvedValueOnce([moduleRecord("disabled")]);
    await act(() => usePluginFrontendStore.getState().refresh("hello-plugin"));
    expect(screen.getByTestId("plugin-tab-unavailable")).toHaveAttribute("data-reason", "disabled");
    expect(screen.queryByLabelText("module draft")).toBeNull();
    expect(stopped).toHaveBeenCalledTimes(1);
    await act(() => usePluginFrontendStore.getState().refresh("hello-plugin"));
    expect((await screen.findByLabelText("module draft") as HTMLInputElement).value).toBe("draft");
    expect(importer).toHaveBeenCalledTimes(2);
    expect(importer.mock.calls[0][0]).not.toBe(importer.mock.calls[1][0]);
  });

  it("cannot mount an import that finishes after uninstall or overwrite a new version", async () => {
    const old = deferred<PluginFrontendModule>();
    const importer = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce({ default: () => <p>new version</p> });
    render(<PluginTabPane tab={tab} active importer={importer} />);
    await waitFor(() => expect(importer).toHaveBeenCalledTimes(1));
    mocks.list.mockResolvedValueOnce([moduleRecord("uninstalled")]);
    await act(() => usePluginFrontendStore.getState().refresh("hello-plugin"));
    expect(screen.getByTestId("plugin-tab-unavailable")).toHaveAttribute("data-reason", "missing");
    mocks.list.mockResolvedValueOnce([moduleRecord("enabled", "0.2.0")]);
    await act(() => usePluginFrontendStore.getState().refresh("hello-plugin"));
    await screen.findByText("new version");
    await act(async () => old.resolve({ default: () => <p>stale version</p> }));
    expect(screen.queryByText("stale version")).toBeNull();
    expect(screen.getByTestId("plugin-tab-panel")).toHaveAttribute("data-plugin-version", "0.2.0");
  });

  it("keeps missing and undeclared tabs visible without evaluating code", () => {
    const importer = vi.fn();
    const view = render(<PluginTabPane tab={{ ...tab, plugin: { slug: "missing", kind: "missing" } }} active importer={importer} />);
    expect(screen.getByTestId("plugin-tab-unavailable")).toHaveAttribute("data-reason", "missing");
    view.rerender(<PluginTabPane tab={{ ...tab, plugin: { slug: "hello-plugin", kind: "undeclared" } }} active importer={importer} />);
    expect(screen.getByTestId("plugin-tab-unavailable")).toHaveAttribute("data-reason", "unavailable");
    expect(importer).not.toHaveBeenCalled();
  });

  it("contains a chunk/integrity failure and retries with a fresh module identity", async () => {
    const importer = vi.fn().mockRejectedValueOnce(new Error("bad hash")).mockResolvedValueOnce({ default: () => <p>repaired view</p> });
    render(<><p>other tab survives</p><PluginTabPane tab={tab} active importer={importer} /></>);
    expect(await screen.findByTestId("plugin-tab-error")).toHaveTextContent("bad hash");
    expect(screen.getByText("other tab survives")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("plugin-tab-retry"));
    await screen.findByText("repaired view");
    expect(importer.mock.calls[0][0]).not.toBe(importer.mock.calls[1][0]);
  });

  it("loads the actual standalone hello ESM with the shared React hooks and scoped IPC", async () => {
    // Keep Vite's asset URL transform out of this native ESM import.
    const base = import.meta.url;
    const path = new URL("../../../src-tauri/plugins/hello-plugin/frontend/index.js", base).href;
    const importer = vi.fn(() => import(/* @vite-ignore */ path));
    mocks.invoke.mockResolvedValueOnce({ values: ["existing"] }).mockResolvedValueOnce({ values: ["existing", "saved through module"] });
    render(<PluginTabPane tab={tab} active importer={importer} />);
    await screen.findByText("existing");
    fireEvent.change(screen.getByTestId("hello-plugin-value"), { target: { value: "saved through module" } });
    fireEvent.click(screen.getByTestId("hello-plugin-save"));
    await screen.findByText("saved through module");
    expect(mocks.invoke).toHaveBeenLastCalledWith("hello-plugin", "hello/write", { value: "saved through module" }, { requestId: expect.any(String) });
    expect(screen.queryByTestId("plugin-tab-error")).toBeNull();
  });

  it("contains render errors, cancels owned work and rejects callbacks retained by the broken view", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const pending = deferred<unknown>();
    const rejected = vi.fn();
    let retainedApi: PluginFrontendApi | undefined;
    function BrokenView({ api }: PluginFrontendProps) {
      const [broken, setBroken] = useState(false);
      useEffect(() => { retainedApi = api; void api.invoke("hello/read").catch(rejected); }, [api]);
      if (broken) throw new Error("module render failed");
      return <button onClick={() => setBroken(true)}>break module view</button>;
    }
    mocks.invoke.mockReturnValueOnce(pending.promise);
    const importer = vi.fn().mockResolvedValueOnce({ default: BrokenView })
      .mockResolvedValueOnce({ default: () => <p>recovered module</p> });
    try {
      render(<><p>core pane</p><PluginTabPane tab={tab} active importer={importer} /></>);
      fireEvent.click(await screen.findByText("break module view"));
      expect(await screen.findByTestId("plugin-tab-error")).toHaveTextContent("module render failed");
      expect(screen.getByText("core pane")).toBeInTheDocument();
      await waitFor(() => expect(rejected).toHaveBeenCalledWith(expect.objectContaining({ name: "AbortError" })));
      expect(mocks.cancel).toHaveBeenCalledTimes(1);
      await expect(retainedApi!.invoke("hello/write", { value: "stale" })).rejects.toMatchObject({ name: "AbortError" });
      fireEvent.click(screen.getByTestId("plugin-tab-retry"));
      await screen.findByText("recovered module");
      pending.resolve({ values: ["late"] });
      expect(screen.queryByText("late")).toBeNull();
    } finally { consoleError.mockRestore(); }
  });
});
