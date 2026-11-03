import { beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_NETWORK_SETTINGS } from "../../lib/networkSettings";
const mock = vi.hoisted(() => ({ getSession: vi.fn(), getAppProxyConfig: vi.fn() }));
vi.mock("../../lib/ipc", () => mock);
import { prepareMobileProxy } from "./mobileProxyAuth";
const config = { enabled: true, mode: "manual", kind: "socks5", host: "proxy", port: 1080, username: "saved", password_ref: "vault:proxy", session_id: "" };
beforeEach(() => { mock.getSession.mockReset(); mock.getAppProxyConfig.mockReset(); });
it.each(["http", "socks5", "app", "custom"] as const)("locked %s proxy uses an ephemeral phone answer without retaining its saved resolver", async kind => {
  mock.getAppProxyConfig.mockResolvedValue(config);
  const network = { ...DEFAULT_NETWORK_SETTINGS, proxyKind: kind, proxyHost: "proxy", proxyPort: "8080", proxyUser: "saved", proxyPass: "vault:proxy", customProxy: config };
  const ask = vi.fn().mockResolvedValue(["one-shot", "temporary"]);
  const value = await prepareMobileProxy(network, true, ask);
  expect(value).toMatchObject({ proxyKind: kind === "http" ? "http" : "socks5", proxyUser: "one-shot", proxyPass: "temporary", proxySessionId: "", proxySaveAuth: false });
  expect(ask).toHaveBeenCalledWith(expect.stringContaining("代理"), expect.any(String), [{ prompt: "代理用户名", echo: true, initial: "saved" }, { prompt: "代理密码", echo: false, initial: "" }]);
  expect(network.proxyPass).toBe("vault:proxy");
  expect(config.password_ref).toBe("vault:proxy");
});
it.each(["http", "app", "custom"] as const)("materializes saved %s proxy session before asking", async kind => {
  const savedConfig = { ...config, mode: "session", session_id: "proxy-row" };
  mock.getAppProxyConfig.mockResolvedValue(savedConfig);
  mock.getSession.mockResolvedValue({ session_type: "Proxy", host: "bastion", port: 3128, username: "proxy-user", options_json: '{"proxyKind":"http","passwordRef":"vault:saved"}' });
  const value = await prepareMobileProxy({ ...DEFAULT_NETWORK_SETTINGS, proxyKind: kind, proxySessionId: "proxy-row", customProxy: savedConfig }, true, vi.fn().mockResolvedValue(["temp-user", "temp-pass"]));
  expect(value).toMatchObject({ proxyKind: "http", proxyHost: "bastion", proxyPort: "3128", proxyUser: "temp-user", proxyPass: "temp-pass", proxySessionId: "" });
});
it("preserves unlocked references and configured failure instead of falling back direct", async () => {
  const ask = vi.fn();
  expect((await prepareMobileProxy({ ...DEFAULT_NETWORK_SETTINGS, proxyKind: "http", proxyPass: "vault:p" }, false, ask)).proxyPass).toBe("vault:p");
  expect(ask).not.toHaveBeenCalled();
  mock.getAppProxyConfig.mockRejectedValue(new Error("configured proxy unavailable"));
  await expect(prepareMobileProxy({ ...DEFAULT_NETWORK_SETTINGS, proxyKind: "app" }, true, ask)).rejects.toThrow("configured proxy unavailable");
});
