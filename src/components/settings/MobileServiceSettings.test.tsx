import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "../../lib/i18n";
import { MobileServiceSettings } from "./MobileServiceSettings";

const ipc = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: ipc }));
vi.mock("../../lib/mfa/qrSvg", () => ({ qrSvgModel: async () => ({ size: 21, path: "M0 0h1v1H0z" }) }));
vi.mock("./FeishuAdapterSettings", () => ({ FeishuAdapterSettings: () => null }));

const initial = () => ({ enabled: false, address: null as string | null, failed_attempts: 2, devices: [] as { device_id: string; label: string; origin: string | null; last_used_at: number }[] });

beforeEach(() => {
  setLocale("en");
  ipc.mockImplementation(async command => command === "mobile_listener_get" ? { allowed_hosts: [], allow_all_hosts: false } : initial());
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  setLocale("en");
});

it("translates disabled settings immediately without resetting edited listener options", async () => {
  render(<MobileServiceSettings />);
  await screen.findByText("Mobile remote");
  expect(screen.getByTestId("mobile-settings-status")).toHaveTextContent("Disabled · No listening port");
  expect(screen.getByTestId("mobile-settings-toggle")).toHaveTextContent("Enable mobile service");
  expect(screen.getByTestId("mobile-settings")).not.toHaveTextContent(/[一-鿿]/);
  fireEvent.change(screen.getByTestId("mobile-settings-port"), { target: { value: "9876" } });
  fireEvent.click(screen.getByTestId("mobile-settings-lan"));

  act(() => setLocale("zh-CN"));
  expect(screen.getByRole("heading", { name: "移动服务" })).toBeInTheDocument();
  expect(screen.getByTestId("mobile-settings-status")).toHaveTextContent("已关闭 · 无监听端口");
  expect(screen.getByTestId("mobile-settings-port")).toHaveValue(9876);
  expect(screen.getByTestId("mobile-settings-lan")).toBeChecked();
  expect(screen.getByTestId("mobile-settings")).toHaveTextContent("保险库主密码仅在本机输入");
  expect(screen.getByTestId("mobile-settings")).toHaveTextContent("暂无已配对设备");
});

it("localizes pairing, device metadata and counters while keeping native actions unchanged", async () => {
  const status = { ...initial(), enabled: true, address: "127.0.0.1:8787", devices: [{ device_id: "phone", label: "QA Phone", origin: null, last_used_at: 1700000000 }] };
  ipc.mockImplementation(async (command) => command === "mobile_pairing_code" ? "QA-PAIR-CODE"
    : command === "mobile_listener_get" ? { allowed_hosts: [], allow_all_hosts: false } : status);
  render(<MobileServiceSettings />);
  await screen.findByText("Running · 127.0.0.1:8787");
  expect(screen.getByTestId("mobile-settings-failures")).toHaveTextContent("Failed pairing attempts: 2");
  expect(screen.getByTestId("mobile-settings-device")).toHaveTextContent("Non-browser");
  fireEvent.change(screen.getByTestId("mobile-settings-endpoint"), { target: { value: "https://pc.example.com" } });
  fireEvent.click(screen.getByTestId("mobile-settings-pair"));
  expect(await screen.findByRole("img", { name: "Phone pairing QR code" })).toBeInTheDocument();
  expect(screen.getByTestId("mobile-settings-code")).toHaveTextContent("QA-PAIR-CODE");

  act(() => setLocale("zh-CN"));
  expect(screen.getByTestId("mobile-settings-failures")).toHaveTextContent("配对失败计数：2");
  expect(screen.getByRole("img", { name: "手机配对二维码" })).toBeInTheDocument();
  expect(screen.getByTestId("mobile-settings-code")).toHaveTextContent("QA-PAIR-CODE");
  expect(screen.getByTestId("mobile-settings-endpoint")).toHaveValue("https://pc.example.com");
  fireEvent.click(screen.getByTestId("mobile-settings-revoke"));
  await waitFor(() => expect(ipc).toHaveBeenCalledWith("mobile_revoke", { deviceId: "phone" }));
});
