import { beforeEach, describe, expect, it, vi } from "vitest";

const writeBytes = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("./localVfs", async (original) => ({
  ...await original<typeof import("./localVfs")>(),
  vfsWriteBytes: writeBytes,
}));

import { invoke } from "./tauri-core";

describe("browser invoke domain dispatch", () => {
  beforeEach(() => {
    localStorage.clear();
    writeBytes.mockClear();
  });

  it("preserves raw binary payloads and headers across file stream calls", async () => {
    const path = "/preview/dispatch.bin";
    const handleId = await invoke<string>("write_stream_open", { path });
    await invoke("write_stream_append", new Uint8Array([0, 255, 128]).buffer, {
      headers: { "x-handle-id": handleId },
    });
    await invoke("write_stream_append", new Uint8Array([10, 13]).buffer, {
      headers: { "X-Handle-Id": handleId },
    });
    await invoke("write_stream_close", { handleId });
    expect(writeBytes).toHaveBeenCalledOnce();
    const [actualPath, bytes] = writeBytes.mock.calls[0] as unknown as [string, ArrayBuffer];
    expect(actualPath).toBe(path);
    expect([...new Uint8Array(bytes)]).toEqual([0, 255, 128, 10, 13]);
    await expect(invoke("write_stream_close", { handleId })).rejects.toThrow("not found");
  });

  it("aborts a stream without publishing it or affecting a subsequent stream", async () => {
    const abandoned = await invoke<string>("write_stream_open", { path: "/preview/abandoned.bin" });
    await invoke("write_stream_append", new Uint8Array([1]).buffer, {
      headers: { "x-handle-id": abandoned },
    });
    await invoke("write_stream_abort", { handleId: abandoned });
    expect(writeBytes).not.toHaveBeenCalled();
    await expect(invoke("write_stream_append", new Uint8Array([2]).buffer, {
      headers: { "x-handle-id": abandoned },
    })).rejects.toThrow("not found");
    const next = await invoke<string>("write_stream_open", { path: "/preview/next.bin" });
    await invoke("write_stream_close", { handleId: next });
    expect(writeBytes).toHaveBeenCalledOnce();
  });

  it("persists sessions across dispatch calls and propagates missing-session errors", async () => {
    const session = { id: "dispatch-session", name: "Original", session_type: "ssh" };
    await invoke("save_session", { config: session });
    expect(await invoke("get_session", { id: session.id })).toEqual(session);
    await invoke("save_session", { config: { ...session, name: "Updated" } });
    expect(await invoke("list_sessions")).toEqual([{ ...session, name: "Updated" }]);
    await invoke("delete_session", { id: session.id });
    await expect(invoke("get_session", { id: session.id })).rejects.toThrow("Session not found");
  });

  it("keeps vault locking and error propagation across domain dispatch", async () => {
    await invoke("vault_init", { masterPassword: "fixture-password" });
    await invoke("vault_lock");
    await expect(invoke("vault_put", { kind: "secret", value: "fixture" })).rejects.toThrow("VAULT_LOCKED");
    await expect(invoke("vault_unlock", { masterPassword: "incorrect" })).rejects.toThrow("Incorrect master password");
    expect(await invoke("vault_status")).toMatchObject({ state: "locked" });
    await invoke("vault_unlock", { masterPassword: "fixture-password" });
    expect(await invoke("vault_status")).toMatchObject({ state: "unlocked" });
  });
});
