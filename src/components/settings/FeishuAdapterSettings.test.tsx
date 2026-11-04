import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { setLocale } from "../../lib/i18n";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FeishuAdapterSettings } from "./FeishuAdapterSettings";
const ipc = vi.hoisted(() => vi.fn());
const gate = vi.hoisted(() => vi.fn());
vi.mock("../../lib/vaultGate", () => ({ ensureVaultReady: gate }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: ipc }));
const initial = () => ({ config: { app_id: "", secret_ref: "", bindings: [], mobile_endpoint: "", proxy_mode: "app", custom_proxy: { enabled: true, mode: "manual", kind: "http", host: "", port: 3128, session_id: "", username: "", password_ref: "" } }, secret_configured: false, status: { state: "stopped", error: null, delivered: 0, failed_deliveries: 0, rejected: 0, duplicates: 0, reconnects: 0 } });
beforeEach(() => { setLocale("en"); gate.mockResolvedValue(true); ipc.mockImplementation(async command => command === "list_sessions" ? [] : initial()); });
afterEach(() => { cleanup(); vi.clearAllMocks(); setLocale("en"); });
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
it("translates all settings, counters and secret hints in place without losing drafts", async () => {
  render(<FeishuAdapterSettings mobileEnabled />);
  await screen.findByTestId("feishu-app-id");
  expect(screen.getByRole("heading", { name: "Feishu Agent adapter (P1)" })).toBeInTheDocument();
  expect(screen.getByTestId("feishu-settings")).not.toHaveTextContent(/[一-鿿]/);
  expect(screen.getByTestId("feishu-status")).toHaveTextContent("Stopped · Delivered 0 · Failed 0");
  fireEvent.change(screen.getByTestId("feishu-app-secret"), { target: { value: "unsaved-secret" } });
  fireEvent.change(screen.getByTestId("feishu-bindings"), { target: { value: "ou_draft oc_draft" } });
  act(() => setLocale("zh-CN"));
  expect(screen.getByRole("heading", { name: "飞书 Agent 适配器（P1）" })).toBeInTheDocument();
  expect(screen.getByTestId("feishu-status")).toHaveTextContent("已停止 · 已送达 0 · 发送失败 0");
  expect(screen.getByTestId("feishu-app-secret")).toHaveValue("unsaved-secret");
  expect(screen.getByTestId("feishu-bindings")).toHaveValue("ou_draft oc_draft");
  expect(screen.getByTestId("feishu-settings")).toHaveTextContent("文件内容默认不发送");
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
  expect(await screen.findByTestId("feishu-error")).toHaveTextContent("Check the network and selected proxy");
  act(() => setLocale("zh-CN"));
  expect(screen.getByTestId("feishu-error")).toHaveTextContent("请检查网络与所选代理");
  expect(screen.getByTestId("feishu-error")).toHaveTextContent("feishu_network_failed_check_proxy");
});

it.each([true, false])("handles an on-demand locked vault, ready=%s, retaining unsaved inputs on cancellation", async ready => {
  gate.mockResolvedValueOnce(ready);
  const view = initial();
  let saves = 0;
  ipc.mockImplementation(async (command, args) => {
    if (command === "vault_status") return { state: "locked", entry_count: 0 };
    if (command === "mobile_feishu_save") {
      if (++saves === 1) throw "VAULT_LOCKED";
      return { ...view, config: { ...args.config, secret_ref: "vault:stored" }, secret_configured: true };
    }
    return view;
  });
  render(<FeishuAdapterSettings mobileEnabled={false} />);
  fireEvent.change(await screen.findByTestId("feishu-app-secret"), { target: { value: "retained-secret" } });
  fireEvent.click(screen.getByTestId("feishu-save"));
  if (ready) {
    await screen.findByTestId("feishu-saved");
    expect(saves).toBe(2);
    expect(screen.getByTestId("feishu-app-secret")).toHaveValue("");
  } else {
    expect(await screen.findByTestId("feishu-error")).toHaveTextContent("inputs have been retained");
    expect(saves).toBe(1);
    expect(screen.getByTestId("feishu-app-secret")).toHaveValue("retained-secret");
  }
  expect(gate).toHaveBeenCalledWith(expect.stringContaining("Feishu credentials"));
});
