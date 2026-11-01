import { afterEach, expect, it, vi } from "vitest";
import { request, ApiError } from "./api";
afterEach(() => vi.unstubAllGlobals());
it("reports the HTTP body limit without misreporting a network failure", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 413, ok: false, json: async () => { throw new SyntaxError("not JSON"); } }));
  await expect(request({ endpoint: "https://pc.example", token: "t" }, "/sessions/thread:t/message", { text: "中".repeat(32768) }))
    .rejects.toMatchObject({ code: "message_too_large" });
});
it("keeps authentication errors readable and never sends browser cookies", async () => {
  const fetch = vi.fn().mockResolvedValue({ status: 403, ok: false, json: async () => ({ error: "origin_denied" }) });
  vi.stubGlobal("fetch", fetch);
  await expect(request({ endpoint: "https://pc.example", token: "t" }, "/ws-ticket", {})).rejects.toBeInstanceOf(ApiError);
  expect(fetch.mock.calls[0][1]).toMatchObject({ credentials: "omit", headers: { Authorization: "Bearer t" } });
});
