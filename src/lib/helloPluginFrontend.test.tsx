import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installPluginFrontendHost, type PluginFrontendProps } from "./pluginFrontendHost";
import { deferred } from "./tests/pluginFrontendHarness";

let HelloPlugin: ComponentType<PluginFrontendProps>;

afterEach(cleanup);

beforeAll(async () => {
  installPluginFrontendHost();
  // @ts-expect-error The standalone archive ESM deliberately has no app TS build dependency.
  HelloPlugin = (await import("../../src-tauri/plugins/hello-plugin/frontend/index.js")).default;
});

describe("independent hello frontend", () => {
  it("distinguishes loading, visible empty data and a saved host response", async () => {
    const read = deferred<{ values: string[] }>();
    const invoke = vi.fn().mockReturnValueOnce(read.promise).mockResolvedValueOnce({ values: ["persisted message"] });
    const api = { invoke, dispose: vi.fn() };
    render(<HelloPlugin tabId="module-one" kind="hello-plugin" active api={api} />);
    expect(screen.getByRole("status")).toHaveTextContent(/Loading|加载/);
    expect(screen.queryByTestId("hello-plugin-values")).toBeNull();
    await act(async () => read.resolve({ values: [] }));
    expect(screen.getByTestId("hello-plugin-values")).toHaveAttribute("data-state", "empty");
    expect(screen.getByTestId("hello-plugin-empty")).toHaveTextContent(/No saved messages|暂无/);
    expect(screen.queryAllByTestId("hello-plugin-entry")).toHaveLength(0);
    fireEvent.change(screen.getByTestId("hello-plugin-value"), { target: { value: "persisted message" } });
    fireEvent.click(screen.getByTestId("hello-plugin-save"));
    await waitFor(() => expect(screen.getByTestId("hello-plugin-entry")).toHaveTextContent("persisted message"));
    expect(screen.getByTestId("hello-plugin-values")).toHaveAttribute("data-state", "populated");
    expect(screen.queryByTestId("hello-plugin-empty")).toBeNull();
    expect(invoke).toHaveBeenLastCalledWith("hello/write", { value: "persisted message" });
  });

  it("shows a read failure without reporting an empty successful result", async () => {
    const api = { invoke: vi.fn().mockRejectedValue(new Error("host unavailable")), dispose: vi.fn() };
    render(<HelloPlugin tabId="module-error" kind="hello-plugin" active api={api} />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("host unavailable"));
    expect(screen.queryByTestId("hello-plugin-empty")).toBeNull();
    expect(screen.queryByTestId("hello-plugin-values")).toBeNull();
  });
});
