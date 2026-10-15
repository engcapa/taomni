import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { GoProxyFields } from "./GoProxyFields";
import type { LlmProviderConfig } from "../../stores/aiStore";

const ipc = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: ipc }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("defaults to app and retains independent settings across proxy mode changes", async () => {
  ipc.mockImplementation(async (command) => command === "list_sessions" ? [] : null);
  const changed = vi.fn();
  function Harness() {
    const [provider, setProvider] = useState<LlmProviderConfig>({
      base_url: "https://example.invalid", api_key: "", model: "model", runtime: "opencode-go",
    });
    return <GoProxyFields provider={provider} onChange={(next) => { setProvider(next); changed(next); }} />;
  }
  render(<Harness />);
  expect(screen.getByTestId("go-proxy-mode")).toHaveValue("app");
  fireEvent.change(screen.getByTestId("go-proxy-mode"), { target: { value: "custom" } });
  fireEvent.change(await screen.findByPlaceholderText("Proxy host"), { target: { value: "go-proxy.local" } });
  await waitFor(() => expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({
    proxy_mode: "custom", custom_proxy: expect.objectContaining({ host: "go-proxy.local" }),
  })));
  for (const mode of ["none", "app", "custom"]) {
    fireEvent.change(screen.getByTestId("go-proxy-mode"), { target: { value: mode } });
  }
  expect(await screen.findByPlaceholderText("Proxy host")).toHaveValue("go-proxy.local");
  expect(ipc.mock.calls.some(([command]) => ["get_app_proxy_config", "save_app_proxy_config"].includes(command))).toBe(false);
});

it("preserves legacy manual settings while allowing explicit no proxy", () => {
  const onChange = vi.fn();
  render(<GoProxyFields provider={{ base_url: "", api_key: "", model: "model", runtime: "opencode-go",
    proxy_mode: "manual", proxy_url: "http://localhost:3128" }} onChange={onChange} />);
  expect(screen.getByDisplayValue("http://localhost:3128")).toBeVisible();
  fireEvent.change(screen.getByTestId("go-proxy-mode"), { target: { value: "none" } });
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ proxy_mode: "none", proxy_url: "http://localhost:3128" }));
});
