import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AppProxyPanel } from "./AppProxyPanel";
const ipc = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: ipc }));
afterEach(cleanup);
it("retains application Settings persistence and its existing connection test", async () => {
  ipc.mockImplementation(async (command) => {
    if (command === "get_app_proxy_config") return { enabled: true, mode: "manual", kind: "http", host: "old", port: 3128, session_id: "", username: "", password_ref: "" };
    if (command === "list_sessions") return [];
    if (command === "test_proxy_connection") return "Connected";
    return null;
  });
  render(<AppProxyPanel />);
  fireEvent.change(await screen.findByPlaceholderText("Proxy host"), { target: { value: "proxy.local" } });
  await waitFor(() => expect(ipc).toHaveBeenCalledWith("save_app_proxy_config", { config: expect.objectContaining({ host: "proxy.local" }) }));
  fireEvent.click(screen.getByText("Test", { exact: true }));
  expect(await screen.findByText("Connected")).toBeVisible();
  expect(ipc).toHaveBeenCalledWith("test_proxy_connection", expect.objectContaining({ testHost: "www.google.com" }));
});
it("persists an embedded proxy without reading or overwriting application settings", async () => {
  ipc.mockClear();
  ipc.mockImplementation(async (command) => command === "list_sessions" ? [] : null);
  const save = vi.fn().mockResolvedValue(undefined);
  render(<AppProxyPanel value={{ enabled: true, mode: "manual", kind: "http", host: "feature.proxy", port: 3128, username: "", password_ref: "vault:feature", session_id: "" }} onSave={save} />);
  fireEvent.change(screen.getByLabelText("Proxy host"), { target: { value: "independent.proxy" } });
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ host: "independent.proxy", password_ref: "vault:feature" })));
  expect(ipc.mock.calls.some(([command]) => command === "get_app_proxy_config" || command === "save_app_proxy_config")).toBe(false);
});
