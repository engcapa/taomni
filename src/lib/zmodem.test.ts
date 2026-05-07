import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session, Transfer } from "zmodem.js";
import { ZmodemSession, type ZmodemCallbacks } from "./zmodem";

const zmodemMock = vi.hoisted(() => {
  let options: {
    on_detect: (detection: { confirm: () => Session }) => void;
  } | null = null;

  const Sentry = vi.fn().mockImplementation((opts) => {
    options = opts;
    return { consume: vi.fn() };
  });

  return {
    Sentry,
    getOptions: () => options,
    reset: () => {
      options = null;
      Sentry.mockClear();
    },
  };
});

vi.mock("zmodem.js", () => ({
  Sentry: zmodemMock.Sentry,
}));

describe("ZmodemSession", () => {
  beforeEach(() => {
    zmodemMock.reset();
  });

  it("asks for local files when the remote starts rz without queued files", async () => {
    const transfer = makeTransfer();
    const session = makeSendSession(transfer);
    const selectFiles = vi.fn(async () => [
      { name: "hello.txt", bytes: new Uint8Array([1, 2, 3]) },
    ]);
    const callbacks = makeCallbacks({ onSelectSendFiles: selectFiles });

    new ZmodemSession(vi.fn(), callbacks);
    detect(session);

    await expect.poll(() => session.close.mock.calls.length).toBe(1);

    expect(selectFiles).toHaveBeenCalledTimes(1);
    expect(session.send_offer).toHaveBeenCalledWith({
      name: "hello.txt",
      size: 3,
      mtime: expect.any(Number),
    });
    expect(transfer.send).toHaveBeenCalledWith([1, 2, 3]);
    expect(transfer.end).toHaveBeenCalledWith([]);
    expect(callbacks.onComplete).toHaveBeenCalledWith("hello.txt");
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(callbacks.onStateChange).toHaveBeenCalledWith("sending");
    expect(callbacks.onStateChange).toHaveBeenLastCalledWith("idle");
  });

  it("aborts the remote rz session when file selection is canceled", async () => {
    const session = makeSendSession(makeTransfer());
    const callbacks = makeCallbacks({ onSelectSendFiles: vi.fn(async () => []) });

    new ZmodemSession(vi.fn(), callbacks);
    detect(session);

    await expect.poll(() => session.abort.mock.calls.length).toBe(1);

    expect(session.send_offer).not.toHaveBeenCalled();
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(callbacks.onStateChange).toHaveBeenLastCalledWith("idle");
  });

  it("uses queued files without prompting when send was initiated locally", async () => {
    const transfer = makeTransfer();
    const session = makeSendSession(transfer);
    const selectFiles = vi.fn(async () => [
      { name: "unused.txt", bytes: new Uint8Array([9]) },
    ]);
    const callbacks = makeCallbacks({ onSelectSendFiles: selectFiles });
    const zmodem = new ZmodemSession(vi.fn(), callbacks);

    zmodem.queueSend([{ name: "queued.bin", bytes: new Uint8Array([7, 8]) }]);
    detect(session);

    await expect.poll(() => session.close.mock.calls.length).toBe(1);

    expect(selectFiles).not.toHaveBeenCalled();
    expect(session.send_offer).toHaveBeenCalledWith({
      name: "queued.bin",
      size: 2,
      mtime: expect.any(Number),
    });
    expect(transfer.send).toHaveBeenCalledWith([7, 8]);
  });
});

function makeCallbacks(overrides: Partial<ZmodemCallbacks> = {}): ZmodemCallbacks {
  return {
    onTerminalData: vi.fn(),
    onStateChange: vi.fn(),
    onProgress: vi.fn(),
    onSelectSaveDir: vi.fn(async () => null),
    onSelectSendFiles: vi.fn(async () => null),
    onWriteFile: vi.fn(async () => undefined),
    onComplete: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
}

function makeTransfer() {
  return {
    send: vi.fn(),
    end: vi.fn(async () => undefined),
  } as Transfer & {
    send: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
}

function makeSendSession(transfer: Transfer) {
  return {
    type: "send" as const,
    on: vi.fn(),
    start: vi.fn(),
    close: vi.fn(async () => undefined),
    send_offer: vi.fn(async () => transfer),
    abort: vi.fn(),
  } as unknown as Session & {
    close: ReturnType<typeof vi.fn>;
    send_offer: ReturnType<typeof vi.fn>;
    abort: ReturnType<typeof vi.fn>;
  };
}

function detect(session: Session) {
  zmodemMock.getOptions()?.on_detect({
    confirm: () => session,
  });
}
