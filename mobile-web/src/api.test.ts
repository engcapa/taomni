import { afterEach, expect, it, vi } from "vitest";
import { request, ApiError, errorText, loadInstances } from "./api";
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });
it("reports the HTTP body limit without misreporting a network failure", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 413, ok: false, json: async () => { throw new SyntaxError("not JSON"); } }));
  await expect(request({ endpoint: "https://pc.example", token: "t" }, "/sessions/thread:t/message", { text: "中".repeat(32768) }))
    .rejects.toMatchObject({ code: "message_too_large" });
});
it.each(["", "/"])("keeps same-origin gateway cookies for public and authenticated API requests (%s)", async suffix => {
  const fetch = vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => ({}) });
  vi.stubGlobal("fetch", fetch);
  const address = location.origin + suffix;
  await request({ endpoint: address.replace(/\/$/, ""), token: "" }, "/pair", { pairing_code: "qa-once" });
  await request({ endpoint: address.replace(/\/$/, ""), token: "phone-token" }, "/ws-ticket", {});
  expect(fetch.mock.calls[0][1]).toMatchObject({ credentials: "same-origin" });
  expect(fetch.mock.calls[0][1].headers).not.toHaveProperty("Authorization");
  expect(fetch.mock.calls[1][1]).toMatchObject({ credentials: "same-origin", headers: { Authorization: "Bearer phone-token" } });
});
it.each(["https://pc.example", "http://localhost:9876", "http://127.0.0.1"])("omits gateway cookies when the instance is another origin: %s", async address => {
  const fetch = vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => ({}) });
  vi.stubGlobal("fetch", fetch);
  await request({ endpoint: address, token: "phone-token" }, "/sessions");
  expect(fetch.mock.calls[0][1]).toMatchObject({ credentials: "omit", headers: { Authorization: "Bearer phone-token" } });
});
it.each([200, 401, 403])("rejects non-JSON gateway responses (HTTP %s) instead of returning an empty success", async status => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status, ok: status === 200, json: async () => { throw new SyntaxError("gateway login page"); } }));
  await expect(request({ endpoint: location.origin, token: "" }, "/pair", { pairing_code: "qa-code" }))
    .rejects.toMatchObject({ code: "invalid_api_response" });
});
it.each([{ type: "opaqueredirect", status: 0 }, { type: "basic", status: 302 }])("reports gateway redirect without following it with credentials (%s)", async response => {
  const fetch = vi.fn().mockResolvedValue({ ...response, ok: false, json: async () => ({}) });
  vi.stubGlobal("fetch", fetch);
  await expect(request({ endpoint: location.origin, token: "phone-token" }, "/sessions"))
    .rejects.toMatchObject({ code: "gateway_auth_required" });
  expect(fetch.mock.calls[0][1].redirect).toBe("manual");
});
it("filters malformed persisted pairings without changing valid devices", () => {
  const good = { id: "old-valid-id", deviceId: "phone", token: "qa-token", endpoint: "https://pc.example", label: "Good" };
  const invalid = [
    { ...good, id: "https://pc.example:undefined", deviceId: "" },
    { ...good, id: "empty-token", token: "" },
    { ...good, id: "credentials-in-url", endpoint: "https://user:password@pc.example" },
    { ...good, id: "bad-protocol", endpoint: "javascript:alert(1)" },
    { ...good, id: "blank-label", label: "" },
  ];
  localStorage.setItem("taomni.mobile.instances.v1", JSON.stringify([good, ...invalid]));
  expect(loadInstances()).toEqual([good]);
});
it("keeps cross-origin authentication errors readable without browser cookies", async () => {
  const fetch = vi.fn().mockResolvedValue({ status: 403, ok: false, json: async () => ({ error: "origin_denied" }) });
  vi.stubGlobal("fetch", fetch);
  await expect(request({ endpoint: "https://pc.example", token: "t" }, "/ws-ticket", {})).rejects.toBeInstanceOf(ApiError);
  expect(fetch.mock.calls[0][1]).toMatchObject({ credentials: "omit", headers: { Authorization: "Bearer t" } });
});

it("explains desktop screen opt-in, invalid browser URLs, and missing window errors clearly", () => {
  expect(errorText(new ApiError("screen_capture_disabled"))).toContain("未开启远程查看屏幕");
  expect(errorText(new ApiError("invalid_browser_url"))).toContain("http://");
  expect(errorText(new ApiError("window_not_found"))).toContain("窗口已关闭");
});
