import { describe, expect, it, vi, beforeEach } from "vitest";

const clipboardTestMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  tauri: false,
  platform: "linux" as "linux" | "macos" | "windows" | "unknown",
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: clipboardTestMocks.invoke,
}));

vi.mock("./runtime", () => ({
  getAppPlatform: () => clipboardTestMocks.platform,
  isTauriRuntime: () => clipboardTestMocks.tauri,
}));

import {
  readClipboardImageFiles,
  readMultiFormat,
  readNativeTextResult,
  readNativeClipboardImagePath,
  readPasteText,
  writeMultiFormat,
  writeText,
  writeImagePng,
} from "./clipboard";

beforeEach(() => {
  clipboardTestMocks.invoke.mockReset().mockRejectedValue(new Error("browser runtime"));
  clipboardTestMocks.tauri = false;
  clipboardTestMocks.platform = "linux";
});

describe("clipboard.readNativeTextResult", () => {
  it("returns the exact native IPC result without consulting Web Clipboard", async () => {
    const webRead = vi.fn().mockResolvedValue("cached-webkit-value");
    Object.defineProperty(globalThis, "navigator", {
      value: { clipboard: { readText: webRead } },
      configurable: true,
    });
    clipboardTestMocks.tauri = true;
    clipboardTestMocks.invoke.mockResolvedValue("native-owner-value");

    await expect(readNativeTextResult()).resolves.toEqual({
      ok: true,
      text: "native-owner-value",
    });
    expect(clipboardTestMocks.invoke).toHaveBeenCalledWith("clipboard_read_text");
    expect(webRead).not.toHaveBeenCalled();
  });

  it("keeps native conversion failure observable instead of returning cached WebKit text", async () => {
    const webRead = vi.fn().mockResolvedValue("cached-webkit-value");
    Object.defineProperty(globalThis, "navigator", {
      value: { clipboard: { readText: webRead } },
      configurable: true,
    });
    clipboardTestMocks.tauri = true;
    clipboardTestMocks.invoke.mockRejectedValue(new Error("X11 conversion refused"));

    await expect(readNativeTextResult()).resolves.toEqual({ ok: false, text: "" });
    expect(webRead).not.toHaveBeenCalled();
  });
});

describe("clipboard.writeText", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "navigator", {
      value: { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } },
      configurable: true,
    });
  });

  it("calls navigator.clipboard.writeText", async () => {
    await writeText("hello");
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("hello");
  });

  it("is a no-op for empty input", async () => {
    await writeText("");
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });
});

describe("clipboard.writeMultiFormat", () => {
  it("uses ClipboardItem when html provided", async () => {
    const writeMock = vi.fn().mockResolvedValue(undefined);
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis, "navigator", {
      value: { clipboard: { write: writeMock, writeText: writeTextMock } },
      configurable: true,
    });
    // jsdom provides ClipboardItem when navigator.clipboard exists, but be safe.
    if (typeof ClipboardItem === "undefined") {
      (globalThis as unknown as { ClipboardItem: unknown }).ClipboardItem = class {
        constructor(public items: Record<string, Blob>) {}
      };
    }

    await writeMultiFormat({ text: "plain", html: "<b>x</b>" });
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeTextMock).not.toHaveBeenCalled();
  });

  it("falls back to writeText when only text provided", async () => {
    const writeMock = vi.fn().mockResolvedValue(undefined);
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis, "navigator", {
      value: { clipboard: { write: writeMock, writeText: writeTextMock } },
      configurable: true,
    });
    await writeMultiFormat({ text: "plain" });
    expect(writeTextMock).toHaveBeenCalledWith("plain");
  });
});

describe("clipboard.readMultiFormat", () => {
  it("returns plain text when read() unavailable", async () => {
    Object.defineProperty(globalThis, "navigator", {
      value: { clipboard: { readText: vi.fn().mockResolvedValue("hello") } },
      configurable: true,
    });
    const result = await readMultiFormat();
    expect(result.text).toBe("hello");
    expect(result.html).toBeUndefined();
  });

  it("collects html when present in clipboard items", async () => {
    const htmlBlob = new Blob(["<p>x</p>"], { type: "text/html" });
    Object.defineProperty(globalThis, "navigator", {
      value: {
        clipboard: {
          readText: vi.fn().mockResolvedValue("x"),
          read: vi.fn().mockResolvedValue([
            {
              types: ["text/plain", "text/html"],
              getType: vi.fn(async (t: string) =>
                t === "text/html" ? htmlBlob : new Blob(["x"]),
              ),
            },
          ]),
        },
      },
      configurable: true,
    });
    const result = await readMultiFormat();
    expect(result.text).toBe("x");
    expect(result.html).toBe("<p>x</p>");
  });
});

describe("clipboard.writeImagePng", () => {
  it("uses the native image clipboard on desktop runtimes", async () => {
    clipboardTestMocks.tauri = true;
    clipboardTestMocks.invoke.mockResolvedValue(undefined);
    await writeImagePng(new Blob([Uint8Array.of(1, 2, 3)], { type: "image/png" }));
    expect(clipboardTestMocks.invoke).toHaveBeenCalledWith("clipboard_write_image_png", Uint8Array.of(1, 2, 3));
  });

  it("rejects when ClipboardItem unavailable", async () => {
    const original = (globalThis as { ClipboardItem?: unknown }).ClipboardItem;
    delete (globalThis as { ClipboardItem?: unknown }).ClipboardItem;
    Object.defineProperty(globalThis, "navigator", {
      value: { clipboard: {} },
      configurable: true,
    });
    await expect(writeImagePng(new Blob([]))).rejects.toThrow();
    if (original) (globalThis as { ClipboardItem?: unknown }).ClipboardItem = original;
  });

  it("invokes native clipboard_write_image_png with PNG bytes inside Tauri without Navigator ClipboardItem", async () => {
    const original = (globalThis as { ClipboardItem?: unknown }).ClipboardItem;
    delete (globalThis as { ClipboardItem?: unknown }).ClipboardItem;
    Object.defineProperty(globalThis, "navigator", {
      value: { clipboard: {} },
      configurable: true,
    });
    clipboardTestMocks.tauri = true;
    clipboardTestMocks.invoke.mockResolvedValue(undefined);
    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

    try {
      await expect(writeImagePng(new Blob([pngBytes], { type: "image/png" }))).resolves.toBeUndefined();
      expect(clipboardTestMocks.invoke).toHaveBeenCalledTimes(1);
      const [cmd, payload] = clipboardTestMocks.invoke.mock.calls[0];
      expect(cmd).toBe("clipboard_write_image_png");
      expect(Array.from(payload as Uint8Array)).toEqual(Array.from(pngBytes));
    } finally {
      if (original) (globalThis as { ClipboardItem?: unknown }).ClipboardItem = original;
    }
  });

  it("rejects empty PNG blobs in Tauri before invoking native clipboard", async () => {
    clipboardTestMocks.tauri = true;
    await expect(writeImagePng(new Blob([], { type: "image/png" }))).rejects.toThrow("empty");
    expect(clipboardTestMocks.invoke).not.toHaveBeenCalled();
  });
});

describe("clipboard.readNativeClipboardImagePath", () => {
  it("returns null outside Tauri", async () => {
    await expect(readNativeClipboardImagePath()).resolves.toBeNull();
  });
});

describe("clipboard.readClipboardImageFiles", () => {
  it("returns empty when clipboard.read is unavailable", async () => {
    Object.defineProperty(globalThis, "navigator", {
      value: { clipboard: {} },
      configurable: true,
    });
    await expect(readClipboardImageFiles()).resolves.toEqual([]);
  });
});

describe("clipboard.readPasteText", () => {
  it("keeps a non-empty webview result and does not consult the native owner", async () => {
    const webRead = vi.fn().mockResolvedValue("webview text");
    Object.defineProperty(globalThis, "navigator", { value: { clipboard: { readText: webRead } }, configurable: true });
    clipboardTestMocks.tauri = true;

    await expect(readPasteText()).resolves.toBe("webview text");
    expect(clipboardTestMocks.invoke).not.toHaveBeenCalled();
  });

  it("falls back to the native owner when the webview read rejects (WebView2 denial)", async () => {
    const webRead = vi.fn().mockRejectedValue(new DOMException("Read permission denied", "NotAllowedError"));
    Object.defineProperty(globalThis, "navigator", { value: { clipboard: { readText: webRead } }, configurable: true });
    clipboardTestMocks.tauri = true;
    clipboardTestMocks.invoke.mockResolvedValue("native text");

    await expect(readPasteText()).resolves.toBe("native text");
    expect(clipboardTestMocks.invoke).toHaveBeenCalledWith("clipboard_read_text");
  });

  it("retries the native owner when the webview resolves an empty string", async () => {
    const webRead = vi.fn().mockResolvedValue("");
    Object.defineProperty(globalThis, "navigator", { value: { clipboard: { readText: webRead } }, configurable: true });
    clipboardTestMocks.tauri = true;
    clipboardTestMocks.invoke.mockResolvedValue("native only text");

    await expect(readPasteText()).resolves.toBe("native only text");
  });

  it("returns empty text when both owners have nothing to paste", async () => {
    const webRead = vi.fn().mockResolvedValue("");
    Object.defineProperty(globalThis, "navigator", { value: { clipboard: { readText: webRead } }, configurable: true });
    clipboardTestMocks.tauri = true;
    clipboardTestMocks.invoke.mockRejectedValue(new Error("clipboard read: ContentNotAvailable"));

    await expect(readPasteText()).resolves.toBe("");
  });
});
