import { beforeEach, describe, expect, it, vi } from "vitest";
import { appendRecoveryOutput, observeRecoveryTerminal, RECOVERY_OUTPUT_CHARS } from "./recoveryTerminal";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), channels: [] as Array<{ id: number; onmessage: (data: ArrayBuffer | number[]) => void }> }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  Channel: class {
    id = mocks.channels.length;
    onmessage = (_: unknown) => {};
    constructor() { mocks.channels.push(this); }
  },
}));
describe("read-only original terminal observation", () => {
  beforeEach(() => { mocks.channels.length = 0; mocks.invoke.mockReset(); mocks.invoke.mockResolvedValue(undefined); });
  it("attaches the original ID and only detaches its own channel on cleanup", async () => {
    const output = vi.fn();
    const subscription = observeRecoveryTerminal("original-pty", output);
    await subscription.ready;
    mocks.channels[0].onmessage([65, 66]);
    expect(output).toHaveBeenCalledWith(Uint8Array.from([65, 66]));
    subscription.stop();
    subscription.stop();
    await Promise.resolve();
    mocks.channels[0].onmessage([67]);
    expect(output).toHaveBeenCalledTimes(1);
    expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual(["attach_terminal_output", "detach_terminal_output"]);
    expect(mocks.invoke.mock.calls[1][1]).toEqual({ sessionId: "original-pty", channelId: 0 });
  });
  it("removes a late attach after unmount without closing, writing or resizing", async () => {
    let resolve!: () => void;
    mocks.invoke.mockReturnValueOnce(new Promise<void>((done) => { resolve = done; }));
    const output = vi.fn();
    const subscription = observeRecoveryTerminal("original-pty", output);
    subscription.stop();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    mocks.channels[0].onmessage([65]);
    expect(output).not.toHaveBeenCalled();
    resolve();
    await subscription.ready;
    await Promise.resolve();
    expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual(["attach_terminal_output", "detach_terminal_output"]);
  });
  it("preserves attach failure and never creates a replacement shell", async () => {
    mocks.invoke.mockRejectedValueOnce(new Error("Terminal not found"));
    const subscription = observeRecoveryTerminal("ended", vi.fn());
    await expect(subscription.ready).rejects.toThrow("Terminal not found");
    expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual(["attach_terminal_output"]);
  });
  it("caps retained text and clipping work for oversized chunks", () => {
    const huge = new Uint8Array(2 * 1024 * 1024).fill(65);
    expect(appendRecoveryOutput("old", huge)).toBe("A".repeat(RECOVERY_OUTPUT_CHARS));
    expect(appendRecoveryOutput("A".repeat(RECOVERY_OUTPUT_CHARS), Uint8Array.of(66))).toBe(
      "A".repeat(RECOVERY_OUTPUT_CHARS - 1) + "B",
    );
  });
});
