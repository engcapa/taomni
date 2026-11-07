import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "../../lib/i18n";
import type { MobileListenerConfig } from "../../lib/mobileListener";
import { MobileHostSettings } from "./MobileHostSettings";

const ipc = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: ipc }));
const defaults = (): MobileListenerConfig => ({ allowed_hosts: [], allow_all_hosts: false });

beforeEach(() => {
  setLocale("en");
  ipc.mockImplementation(async (command, args) => command === "mobile_listener_save" ? args.config : defaults());
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  setLocale("en");
});

async function ready() {
  await waitFor(() => expect(screen.getByTestId("mobile-settings-save-hosts")).toBeEnabled());
}

it("defaults to restricted domains and only enables saving after persisted policy loads", async () => {
  let resolve!: (value: MobileListenerConfig) => void;
  ipc.mockReturnValue(new Promise<MobileListenerConfig>(done => { resolve = done; }));
  render(<MobileHostSettings />);
  expect(screen.getByTestId("mobile-settings-hosts-loading")).toBeInTheDocument();
  expect(screen.getByTestId("mobile-settings-allow-all-hosts")).not.toBeChecked();
  expect(screen.getByTestId("mobile-settings-allow-all-hosts")).toBeDisabled();
  expect(screen.getByTestId("mobile-settings-save-hosts")).toBeDisabled();
  await act(async () => resolve({ allowed_hosts: ["proxy.example:8443"], allow_all_hosts: false }));
  await ready();
  expect(screen.getByTestId("mobile-settings-allowed-hosts")).toHaveValue("proxy.example:8443");
  expect(screen.getByTestId("mobile-settings-hosts-warning")).toHaveTextContent("DNS rebinding protection");
  expect(screen.getByTestId("mobile-settings-hosts-warning")).toHaveTextContent("Origin checks, bearer tokens and one-time WebSocket tickets are still required");
});

it("saves trimmed exact hosts without restarting the service and uses the backend's normalized result", async () => {
  ipc.mockImplementation(async command => command === "mobile_listener_save"
    ? { allowed_hosts: ["proxy.example", "pc.example:8443"], allow_all_hosts: false }
    : defaults());
  render(<MobileHostSettings />);
  await ready();
  fireEvent.change(screen.getByTestId("mobile-settings-allowed-hosts"), { target: { value: " Proxy.Example \r\n\n pc.example:8443 \nProxy.Example" } });
  fireEvent.click(screen.getByTestId("mobile-settings-save-hosts"));
  await screen.findByTestId("mobile-settings-hosts-saved");
  expect(ipc).toHaveBeenCalledWith("mobile_listener_save", {
    config: { allowed_hosts: ["Proxy.Example", "pc.example:8443", "Proxy.Example"], allow_all_hosts: false },
  });
  expect(screen.getByTestId("mobile-settings-allowed-hosts")).toHaveValue("proxy.example\npc.example:8443");
  expect(ipc.mock.calls.map(([command]) => command)).toEqual(["mobile_listener_get", "mobile_listener_save"]);
});

it("retains the whitelist when allowing all domains, restores it on restriction and survives remount", async () => {
  let config = { allowed_hosts: ["proxy.example"], allow_all_hosts: false };
  ipc.mockImplementation(async (command, args) => {
    if (command === "mobile_listener_save") config = args.config;
    return config;
  });
  const view = render(<MobileHostSettings />);
  await ready();
  fireEvent.click(screen.getByTestId("mobile-settings-allow-all-hosts"));
  expect(screen.getByTestId("mobile-settings-allowed-hosts")).toBeDisabled();
  fireEvent.click(screen.getByTestId("mobile-settings-save-hosts"));
  await screen.findByTestId("mobile-settings-hosts-saved");
  expect(config).toEqual({ allowed_hosts: ["proxy.example"], allow_all_hosts: true });
  view.unmount();
  render(<MobileHostSettings />);
  await ready();
  expect(screen.getByTestId("mobile-settings-allow-all-hosts")).toBeChecked();
  expect(screen.getByTestId("mobile-settings-allowed-hosts")).toHaveValue("proxy.example");
  fireEvent.click(screen.getByTestId("mobile-settings-allow-all-hosts"));
  expect(screen.getByTestId("mobile-settings-allowed-hosts")).toBeEnabled();
  fireEvent.click(screen.getByTestId("mobile-settings-save-hosts"));
  await screen.findByTestId("mobile-settings-hosts-saved");
  expect(config).toEqual({ allowed_hosts: ["proxy.example"], allow_all_hosts: false });
});

it("localizes errors and warnings without losing an edited policy", async () => {
  ipc.mockImplementation(async command => {
    if (command === "mobile_listener_save") throw new Error("invalid_mobile_host");
    return defaults();
  });
  render(<MobileHostSettings />);
  await ready();
  fireEvent.change(screen.getByTestId("mobile-settings-allowed-hosts"), { target: { value: "https://invalid.example/" } });
  fireEvent.click(screen.getByTestId("mobile-settings-save-hosts"));
  expect(await screen.findByRole("alert")).toHaveTextContent("Enter a valid domain or domain:port");
  expect(screen.queryByTestId("mobile-settings-hosts-saved")).not.toBeInTheDocument();
  act(() => setLocale("zh-CN"));
  expect(screen.getByTestId("mobile-settings-allowed-hosts")).toHaveValue("https://invalid.example/");
  expect(screen.getByTestId("mobile-settings-hosts-warning")).toHaveTextContent("DNS 重绑定防护");
  expect(screen.getByTestId("mobile-settings-hosts-warning")).toHaveTextContent("Origin 校验、令牌及一次性 WebSocket 票据");
  expect(screen.getByRole("alert")).toHaveTextContent("请输入有效域名或域名:端口");
});

it("does not overwrite unreadable settings with defaults and supports retry", async () => {
  ipc.mockRejectedValueOnce(new Error("unreadable_mobile_listener_config"));
  render(<MobileHostSettings />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Check file permissions");
  expect(screen.getByTestId("mobile-settings-save-hosts")).toBeDisabled();
  expect(screen.getByTestId("mobile-settings-allow-all-hosts")).toBeDisabled();
  fireEvent.click(screen.getByTestId("mobile-settings-reload-hosts"));
  await ready();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(ipc).toHaveBeenCalledTimes(2);
});

it("prevents duplicate saves and retains the draft on a persistence failure", async () => {
  let reject!: (reason: Error) => void;
  ipc.mockImplementation(async command => command === "mobile_listener_save"
    ? new Promise<MobileListenerConfig>((_, fail) => { reject = fail; })
    : defaults());
  render(<MobileHostSettings />);
  await ready();
  fireEvent.click(screen.getByTestId("mobile-settings-allow-all-hosts"));
  fireEvent.click(screen.getByTestId("mobile-settings-save-hosts"));
  expect(screen.getByTestId("mobile-settings-save-hosts")).toBeDisabled();
  expect(screen.getByTestId("mobile-settings-allow-all-hosts")).toBeDisabled();
  fireEvent.click(screen.getByTestId("mobile-settings-save-hosts"));
  expect(ipc).toHaveBeenCalledTimes(2);
  await act(async () => reject(new Error("mobile_listener_write_failed")));
  expect(await screen.findByRole("alert")).toHaveTextContent("The active policy has not changed");
  expect(screen.getByTestId("mobile-settings-allow-all-hosts")).toBeChecked();
  expect(screen.getByTestId("mobile-settings-save-hosts")).toBeEnabled();
  expect(screen.queryByTestId("mobile-settings-hosts-saved")).not.toBeInTheDocument();
});

it("ignores a stale load result after the Settings page unmounts", async () => {
  let resolve!: (value: MobileListenerConfig) => void;
  ipc.mockReturnValueOnce(new Promise<MobileListenerConfig>(done => { resolve = done; }));
  const previous = render(<MobileHostSettings />);
  previous.unmount();
  render(<MobileHostSettings />);
  await ready();
  await act(async () => resolve({ allowed_hosts: ["stale.example"], allow_all_hosts: true }));
  expect(screen.getByTestId("mobile-settings-allowed-hosts")).toHaveValue("");
  expect(screen.getByTestId("mobile-settings-allow-all-hosts")).not.toBeChecked();
});
