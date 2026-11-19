import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { DEFAULT_FILE_OPEN_PREFERENCES, setFileOpenPreferences, resetFileOpenPreferences } from "./openFile/preferences";
import { readFileMarkdownImage } from "./markdownRemoteImages";
import { readMarkdownImage } from "./markdownAssets";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class { constructor(public onmessage: (id: string) => void) {} },
}));
vi.mock("./runtime", () => ({ isTauriRuntime: () => true }));
vi.mock("./markdownAssets", async (original) => ({
  ...await original<typeof import("./markdownAssets")>(), readMarkdownImage: vi.fn(),
}));

const doc = "/docs/test.md";
const image = "https://example.invalid/image.png";
const response = { bytes: [1, 2, 3], mime: "image/png", size: 3 };
const data = "data:image/png;base64,AQID";

beforeEach(() => {
  setFileOpenPreferences({ markdownRestrictRemoteImages: true });
  resetFileOpenPreferences();
  vi.mocked(invoke).mockReset().mockResolvedValue(response);
});
afterEach(() => resetFileOpenPreferences());

describe("Markdown remote images in preview and export", () => {
  it("allows remote images by default and shares the same data with concurrent and subsequent callers", async () => {
    await expect(Promise.all([
      readFileMarkdownImage(doc, image + "#one"),
      readFileMarkdownImage(doc, image + "#two"),
    ])).resolves.toEqual([data, data]);
    await expect(readFileMarkdownImage(doc, image)).resolves.toBe(data);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("viewer_markdown_image", expect.objectContaining({
      url: image, proxyMode: "app",
    }));
  });

  it("rejects blocked URLs before IPC and continues to read local images", async () => {
    vi.mocked(readMarkdownImage).mockResolvedValue(data);
    setFileOpenPreferences({ markdownRestrictRemoteImages: true });
    await expect(readFileMarkdownImage(doc, image)).rejects.toThrow("blocked in File Open settings");
    await expect(readFileMarkdownImage(doc, "assets/image.png")).resolves.toBe(data);
    expect(readMarkdownImage).toHaveBeenCalledWith(doc, "assets/image.png");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("cancels a pending request even when the native token arrives after the policy change", async () => {
    let ready!: { onmessage: (id: string) => void };
    let complete!: (value: typeof response) => void;
    vi.mocked(invoke).mockImplementation((command, args) => {
      if (command !== "viewer_markdown_image") return Promise.resolve(undefined) as never;
      ready = (args as { ready: typeof ready }).ready;
      return new Promise<typeof response>((resolve) => { complete = resolve; }) as never;
    });
    const previous = readFileMarkdownImage(doc, image);
    setFileOpenPreferences({ markdownRestrictRemoteImages: true });
    ready.onmessage("pending-token");
    expect(invoke).toHaveBeenCalledWith("viewer_markdown_image_cancel", { id: "pending-token" });
    complete(response);
    await expect(previous).rejects.toThrow("access settings changed");
    setFileOpenPreferences({ markdownRestrictRemoteImages: false, markdownProxyMode: "none" });
    vi.mocked(invoke).mockResolvedValue(response);
    await expect(readFileMarkdownImage(doc, image)).resolves.toBe(data);
    expect(invoke).toHaveBeenLastCalledWith("viewer_markdown_image", expect.objectContaining({ proxyMode: "none" }));
  });

  it("does not cache a proxy failure and retries using the same independent proxy", async () => {
    const customProxy = { ...DEFAULT_FILE_OPEN_PREFERENCES.markdownCustomProxy, host: "proxy.example.invalid" };
    setFileOpenPreferences({ markdownProxyMode: "custom", markdownCustomProxy: customProxy });
    vi.mocked(invoke).mockRejectedValueOnce(new Error("Proxy unavailable"));
    await expect(readFileMarkdownImage(doc, image)).rejects.toThrow("Proxy unavailable");
    await expect(readFileMarkdownImage(doc, image)).resolves.toBe(data);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenLastCalledWith("viewer_markdown_image", expect.objectContaining({ proxyMode: "custom", customProxy }));
  });
});
