import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FeishuAdapterSettings } from "./FeishuAdapterSettings";
const ipc = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: ipc }));
const initial = () => ({ config: { app_id: "", secret_ref: "", bindings: [], mobile_endpoint: "", proxy_mode: "app", custom_proxy: { enabled: true, mode: "manual", kind: "http", host: "", port: 3128, session_id: "", username: "", password_ref: "" } }, secret_configured: false, status: { state: "stopped", error: null, delivered: 0, failed_deliveries: 0, rejected: 0, duplicates: 0, reconnects: 0 } });
beforeEach(() => { ipc.mockImplementation(async command => command === "list_sessions" ? [] : initial()); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it("saves only to feature settings, clears the supplied secret and keeps start disabled while mobile is off", async () => {
  const view = initial();
  ipc.mockImplementation(async (command, args) => {
    if (command === "mobile_feishu_save") return { ...view, config: { ...args.config, secret_ref: "vault:stored" }, secret_configured: true };
    return view;
  });
  render(<FeishuAdapterSettings mobileEnabled={false} />);
  fireEvent.change(await screen.findByTestId("feishu-app-id"), { target: { value: "cli_test" } });
  fireEvent.change(screen.getByTestId("feishu-app-secret"), { target: { value: "private-test-secret" } });
  fireEvent.change(screen.getByTestId("feishu-bindings"), { target: { value: "ou_user oc_chat" } });
  fireEvent.click(screen.getByTestId("feishu-save"));
  await screen.findByTestId("feishu-saved");
  expect(ipc).toHaveBeenCalledWith("mobile_feishu_save", expect.objectContaining({ secret: "private-test-secret", config: expect.objectContaining({ bindings: [{ open_id: "ou_user", chat_id: "oc_chat" }] }) }));
  expect(screen.getByTestId("feishu-app-secret")).toHaveValue("");
  expect(screen.getByTestId("feishu-toggle")).toBeDisabled();
});
it("edits an independent proxy without changing application settings", async () => {
  render(<FeishuAdapterSettings mobileEnabled />);
  fireEvent.change(await screen.findByTestId("feishu-proxy-mode"), { target: { value: "custom" } });
  fireEvent.change(await screen.findByPlaceholderText("Proxy host"), { target: { value: "feature.proxy" } });
  for (const value of ["none", "app", "custom"]) fireEvent.change(screen.getByTestId("feishu-proxy-mode"), { target: { value } });
  expect(await screen.findByPlaceholderText("Proxy host")).toHaveValue("feature.proxy");
  fireEvent.click(screen.getByTestId("feishu-save"));
  await waitFor(() => expect(ipc).toHaveBeenCalledWith("mobile_feishu_save", expect.objectContaining({ config: expect.objectContaining({ custom_proxy: expect.objectContaining({ host: "feature.proxy" }) }) })));
  expect(ipc.mock.calls.some(([c]) => c === "save_app_proxy_config")).toBe(false);
});
it("shows actionable native failures and blocks configuration edits while connected", async () => {
  const view = initial(); view.status.state = "connected";
  ipc.mockResolvedValue(view);
  render(<FeishuAdapterSettings mobileEnabled />);
  expect(await screen.findByTestId("feishu-app-id")).toBeDisabled();
  expect(screen.getByTestId("feishu-save")).toBeDisabled();
  ipc.mockRejectedValueOnce("feishu_network_failed_check_proxy");
  fireEvent.click(screen.getByTestId("feishu-toggle"));
  expect(await screen.findByTestId("feishu-error")).toHaveTextContent("check_proxy");
});
