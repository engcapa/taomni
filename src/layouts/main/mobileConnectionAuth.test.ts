import { beforeEach, expect, it, vi } from "vitest";
import type { SessionConfig } from "../../lib/ipc";
const mock = vi.hoisted(() => ({ invoke: vi.fn(), getSession: vi.fn(), state: "empty" }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mock.invoke }));
vi.mock("../../lib/ipc", () => ({ getSession: mock.getSession }));
vi.mock("../../stores/vaultStore", () => ({ useVaultStore: { getState: () => ({ state: mock.state }) } }));
import { prepareMobileSsh } from "./mobileConnectionAuth";
const saved = { id: "s", name: "SSH", host: "host", port: 22, username: "old", session_type: "SSH", auth_method: "Password", options_json: "{}" } as SessionConfig;
beforeEach(() => { mock.invoke.mockReset(); mock.getSession.mockReset(); mock.state = "empty"; });
it("uses a one-shot username/password while leaving saved configuration untouched", async () => {
  mock.invoke.mockResolvedValue(["new-user", "secret"]);
  const value = await prepareMobileSsh(saved, "open-1", new AbortController().signal);
  expect(value.session.username).toBe("new-user"); expect(value.credential).toBe("secret");
  expect(saved.username).toBe("old"); expect(saved.options_json).toBe("{}");
  expect(mock.invoke).toHaveBeenCalledWith("mobile_connection_auth", expect.objectContaining({ requestId: "open-1", prompts: [{ prompt: "用户名", echo: true, initial: "old" }, { prompt: "密码", echo: false, initial: "" }] }));
});
it("uses unlocked vault references, but requests a one-shot password for a locked vault", async () => {
  const session = { ...saved, options_json: '{"passwordRef":"vault:stored"}' };
  mock.state = "unlocked";
  expect((await prepareMobileSsh(session, "open-1", new AbortController().signal)).credential).toBe("vault:stored");
  expect(mock.invoke).not.toHaveBeenCalled();
  mock.state = "locked"; mock.invoke.mockResolvedValue(["old", "temporary"]);
  expect((await prepareMobileSsh(session, "open-2", new AbortController().signal)).credential).toBe("temporary");
  expect(session.options_json).toBe('{"passwordRef":"vault:stored"}');
});
it("prepares saved jump-host credentials without changing that saved session or allowing its vault ref to overwrite the answer", async () => {
  const session = { ...saved, auth_method: { PrivateKey: { key_path: "/key" } }, options_json: '{"networkSettings":{"proxyKind":"ssh-tunnel","jumpSessionId":"jump"}}' } as SessionConfig;
  mock.state = "locked";
  mock.getSession.mockResolvedValue({ ...saved, id: "jump", host: "bastion", username: "jump-user", options_json: '{"passwordRef":"vault:jump"}' });
  mock.invoke.mockResolvedValue(["one-shot-jump", "jump-secret"]);
  const value = await prepareMobileSsh(session, "open-1", new AbortController().signal);
  const options = JSON.parse(value.session.options_json);
  expect(options.networkSettings).toMatchObject({ jumpHost: "bastion", jumpUser: "one-shot-jump", jumpPassword: "jump-secret", jumpSessionId: "", jumpSaveAuth: false });
  expect(session.options_json).toContain('"jumpSessionId":"jump"');
});
it("rejects a late answer after cancellation before creating a connection", async () => {
  const abort = new AbortController(); mock.invoke.mockImplementation(async () => { abort.abort(); return ["old", "late-secret"]; });
  await expect(prepareMobileSsh(saved, "open-1", abort.signal)).rejects.toThrow("open_cancelled");
});
