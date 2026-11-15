import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewerDocument } from "../../lib/viewer";
import type { AppProxyConfig } from "../../lib/ipc/proxy";
// @ts-expect-error node builtin is test-only; production compiler uses DOM globals
import { readFileSync } from "node:fs";
const htmlPreviewCss = readFileSync("src/components/viewer/HtmlPreview.css", "utf8") as string;

const mocks = vi.hoisted(() => ({
  open: vi.fn(), close: vi.fn(), external: vi.fn(), save: vi.fn(), system: vi.fn(), openFile: vi.fn(),
  preferences: { htmlNetwork: "block" as "block" | "ask", htmlScripts: true,
    htmlProxyMode: "app" as "app" | "custom" | "none", htmlCustomProxy: undefined as AppProxyConfig | undefined },
  saveAppProxy: vi.fn(),
}));
vi.mock("../../lib/viewer", () => ({ viewerHtmlOpen: mocks.open, viewerHtmlClose: mocks.close }));
vi.mock("../../lib/ipc/proxy", () => ({ saveAppProxyConfig: mocks.saveAppProxy }));
vi.mock("../../lib/sftp", () => ({ basename: (path: string) => path.split("/").pop(), parentPath: () => "/docs", openExternalUrl: mocks.external, sftpOpenPath: mocks.system }));
vi.mock("../../lib/openFile", () => ({ openFile: mocks.openFile }));
vi.mock("../../lib/openFile/preferences", () => ({ useFileOpenPreferences: () => mocks.preferences }));
vi.mock("../../lib/explorer/openExplorer", () => ({ openExplorer: vi.fn() }));
vi.mock("../../stores/documentStore", () => ({ useDocumentStore: { getState: () => ({ save: mocks.save }) } }));
vi.mock("./EditorSurface", () => ({ EditorSurface: ({ document }: { document: ViewerDocument }) => <textarea data-testid="viewer-editor-content" defaultValue={document.content} /> }));
vi.mock("./viewerLabels", () => ({ useViewerLabels: () => (_zh: string, en: string) => en }));
import { HtmlPreview } from "./HtmlPreview";

function doc(extra: Partial<ViewerDocument> = {}): ViewerDocument {
  return { key: "/docs/report.html", path: "/docs/report.html", kind: "html", content: "<h1>Report</h1>", savedContent: "<h1>Report</h1>", savedHash: "saved", encoding: "UTF-8", bom: false, eol: "LF", savedEncoding: "UTF-8", savedBom: false, savedEol: "LF", originalLineEndings: [], dirty: false, mtime: 1, size: 15, readOnly: false, loading: false, saving: false, large: false, truncated: false, revision: 0, chunkOffset: 0, nextOffset: 15, eof: true, ...extra };
}
async function readyFrame(): Promise<HTMLIFrameElement> {
  const frame = await screen.findByTestId("html-frame") as HTMLIFrameElement;
  // A committed iframe node can appear before React's passive message-listener
  // effect has flushed under a busy full-suite worker. Post exactly once, after
  // that effect is ready; never retry a dropped security-sensitive message.
  await act(async () => { await Promise.resolve(); });
  return frame;
}
function bridge(frame: HTMLIFrameElement, token: string, data: Record<string, unknown>, source: Window | null = frame.contentWindow) {
  act(() => window.dispatchEvent(new MessageEvent("message", { source, data: { type: "taomni-html-preview", token, ...data } })));
}

beforeEach(() => {
  vi.clearAllMocks();
  let generation = 0;
  mocks.open.mockImplementation(async () => {
    const token = `session-${++generation}`;
    return { token, url: `taomni-preview://localhost/${token}/report.html` };
  });
  mocks.close.mockResolvedValue(undefined); mocks.external.mockResolvedValue(undefined); mocks.save.mockResolvedValue(undefined);
  mocks.preferences = { htmlNetwork: "block", htmlScripts: true, htmlProxyMode: "app", htmlCustomProxy: undefined };
});
afterEach(cleanup);

describe("HTML preview renderer", () => {
  it("preserves the prototype full-bleed desktop, device insets, pill address and pane dimensions", async () => {
    const rule = (selector: string) => htmlPreviewCss.slice(htmlPreviewCss.indexOf(selector + " {"), htmlPreviewCss.indexOf("}", htmlPreviewCss.indexOf(selector + " {")) + 1);
    expect(rule(".html-stage")).toContain("padding: 0;");
    expect(rule('.html-stage[data-device="mobile"]')).toContain("padding: 14px 0;");
    expect(rule(".html-address")).toContain("border-radius: 15px;");
    expect(rule(".html-source")).toContain("width: 42%;");
    expect(rule(".html-console")).toContain("height: 150px;");
    expect(rule(".html-stage")).toContain("overflow: auto;");
    const originalWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get() { return this.classList?.contains("html-stage") ? 900 : 0; } });
    try {
      render(<HtmlPreview document={doc()} onError={vi.fn()} />);
      const frame = await readyFrame();
      expect(frame.style.width).toBe("900px");
      expect(screen.getByTestId("html-stage")).toHaveAttribute("data-device", "desktop");
      fireEvent.click(screen.getByTestId("html-device-mobile"));
      expect(frame.style.width).toBe("390px");
      expect(screen.getByTestId("html-stage")).toHaveAttribute("data-device", "mobile");
    } finally {
      if (originalWidth) Object.defineProperty(HTMLElement.prototype, "clientWidth", originalWidth);
      else delete (HTMLElement.prototype as unknown as { clientWidth?: number }).clientWidth;
    }
  });

  it("uses the native token protocol and opaque sandbox, with default offline banner", async () => {
    const { unmount } = render(<HtmlPreview document={doc()} onError={vi.fn()} />);
    const frame = await screen.findByTestId("html-frame");
    expect(mocks.open).toHaveBeenCalledWith("/docs/report.html", false, true, { proxyMode: "app" });
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame.getAttribute("src")).toContain("taomni-preview://localhost/session-1/report.html");
    expect(screen.getByTestId("html-address")).toHaveValue("file:///docs/report.html");
    expect(screen.getByTestId("html-address")).toHaveAttribute("readonly");
    expect(screen.getByTestId("html-network-allow")).toBeEnabled();
    fireEvent.load(frame);
    await waitFor(() => expect(screen.getByTestId("html-preview")).toHaveAttribute("data-loaded", "true"));
    unmount();
    expect(mocks.close).toHaveBeenCalledWith("session-1");
  });

  it.each(["app", "custom", "none"] as const)("starts blocked, then uses %s proxy only for this tab without changing the app proxy", async (proxyMode) => {
    const customProxy: AppProxyConfig = { enabled: true, mode: "manual", session_id: "", kind: "socks5",
      host: "127.0.0.1", port: 1080, username: "user", password_ref: "vault:html-only" };
    mocks.preferences = { ...mocks.preferences, htmlProxyMode: proxyMode, htmlCustomProxy: customProxy };
    const network = proxyMode === "custom" ? { proxyMode, customProxy } : { proxyMode };
    const { unmount } = render(<HtmlPreview document={doc()} onError={vi.fn()} />);
    await screen.findByTestId("html-frame");
    expect(mocks.open).toHaveBeenLastCalledWith("/docs/report.html", false, true, network);
    expect(screen.queryByTestId("html-network-proxy")).toBeNull();
    fireEvent.click(screen.getByTestId("html-network-allow"));
    await waitFor(() => expect(mocks.open).toHaveBeenLastCalledWith("/docs/report.html", true, true, network));
    expect(await screen.findByTestId("html-network-proxy")).toHaveAttribute("data-proxy-mode", proxyMode);
    expect(screen.getByTestId("html-network-proxy")).toHaveTextContent(proxyMode === "custom" ? "HTML-specific proxy" : proxyMode === "none" ? "No proxy (bypass system proxies)" : "Application proxy");
    expect(mocks.preferences.htmlCustomProxy).toEqual(customProxy);
    expect(mocks.saveAppProxy).not.toHaveBeenCalled();
    expect((screen.getByTestId("html-frame") as HTMLIFrameElement).src).toMatch(/^taomni-preview:\/\/localhost\//);
    unmount();
    render(<HtmlPreview document={doc()} onError={vi.fn()} />);
    await waitFor(() => expect(mocks.open).toHaveBeenLastCalledWith("/docs/report.html", false, true, network));
  });

  it("reopens on selected proxy fields, not object identity or inactive custom proxy settings", async () => {
    const customProxy: AppProxyConfig = { enabled: true, mode: "manual", session_id: "", kind: "http", host: "proxy.invalid",
      port: 3128, username: "", password_ref: "vault:initial" };
    mocks.preferences = { ...mocks.preferences, htmlProxyMode: "custom", htmlCustomProxy: customProxy };
    const { rerender } = render(<HtmlPreview document={doc()} onError={vi.fn()} />);
    await screen.findByTestId("html-frame");
    mocks.preferences = { ...mocks.preferences, htmlCustomProxy: { ...customProxy } };
    rerender(<HtmlPreview document={doc()} onError={vi.fn()} />);
    expect(mocks.open).toHaveBeenCalledTimes(1);
    mocks.preferences = { ...mocks.preferences, htmlCustomProxy: { ...customProxy, password_ref: "vault:changed" } };
    rerender(<HtmlPreview document={doc()} onError={vi.fn()} />);
    await waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(2));
    expect(mocks.close).toHaveBeenCalledWith("session-1");
    expect(mocks.open).toHaveBeenLastCalledWith("/docs/report.html", false, true, { proxyMode: "custom", customProxy: { ...customProxy, password_ref: "vault:changed" } });
    mocks.preferences = { ...mocks.preferences, htmlProxyMode: "app" };
    rerender(<HtmlPreview document={doc()} onError={vi.fn()} />);
    await waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(3));
    mocks.preferences = { ...mocks.preferences, htmlCustomProxy: { ...customProxy, host: "unused.invalid" } };
    rerender(<HtmlPreview document={doc()} onError={vi.fn()} />);
    expect(mocks.open).toHaveBeenCalledTimes(3);
  });

  it("reports configured proxy failures without falling back or claiming an active proxy", async () => {
    render(<HtmlPreview document={doc()} onError={vi.fn()} />);
    await screen.findByTestId("html-frame");
    mocks.open.mockRejectedValueOnce(new Error("proxy: connection refused"));
    fireEvent.click(screen.getByTestId("html-network-allow"));
    expect(await screen.findByRole("alert")).toHaveTextContent("proxy: connection refused");
    expect(screen.queryByTestId("html-network-proxy")).toBeNull();
    expect(mocks.open).toHaveBeenCalledTimes(2);
    expect(mocks.open).toHaveBeenLastCalledWith("/docs/report.html", true, true, { proxyMode: "app" });
    fireEvent.click(screen.getByTestId("html-network-block"));
    await waitFor(() => expect(mocks.open).toHaveBeenLastCalledWith("/docs/report.html", false, true, { proxyMode: "app" }));
  });

  it("keeps the frame and editing surface stable across split/device/console changes", async () => {
    render(<HtmlPreview document={doc()} onError={vi.fn()} />);
    const frame = await readyFrame();
    fireEvent.click(screen.getByTestId("html-mode-split"));
    expect(screen.getByTestId("html-source")).not.toHaveAttribute("hidden");
    expect(screen.getByTestId("viewer-editor-content")).toHaveValue("<h1>Report</h1>");
    fireEvent.click(screen.getByTestId("html-device-mobile"));
    expect(frame.style.width).toBe("390px");
    fireEvent.click(screen.getByTestId("html-device-tablet"));
    expect(frame.style.width).toBe("768px");
    fireEvent.change(screen.getByTestId("html-zoom"), { target: { value: "125" } });
    expect(frame.style.transform).toBe("scale(1.25)");
    fireEvent.click(screen.getByTestId("html-console-toggle"));
    expect(screen.getByTestId("html-console")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("html-mode-preview"));
    expect(screen.getByTestId("html-frame")).toBe(frame);
    expect(mocks.open).toHaveBeenCalledTimes(1);
  });

  it("authenticates console and navigation messages; external URLs only use system helper", async () => {
    render(<HtmlPreview document={doc()} onError={vi.fn()} />);
    const frame = await readyFrame();
    fireEvent.click(screen.getByTestId("html-console-toggle"));
    bridge(frame, "session-1", { kind: "console", message: "wrong-source" }, window);
    bridge(frame, "stale", { kind: "console", message: "stale-token" });
    bridge(frame, "session-1", { kind: "console", level: "error", message: "fixture ready" });
    expect(screen.queryByText("wrong-source")).toBeNull();
    expect(screen.queryByText("stale-token")).toBeNull();
    expect(screen.getByText("fixture ready")).toHaveAttribute("data-level", "error");
    bridge(frame, "session-1", { kind: "navigate", href: "taomni-preview://localhost/other/secret.html" });
    expect(frame.src).toContain("/report.html");
    bridge(frame, "session-1", { kind: "navigate", href: "taomni-preview://localhost/session-1/sub/two.html" });
    expect(frame.src).toContain("/sub/two.html");
    expect(screen.getByTestId("html-address")).toHaveValue("file:///docs/sub/two.html");
    fireEvent.click(screen.getByTestId("html-back"));
    expect(frame.src).toContain("/report.html");
    fireEvent.click(screen.getByTestId("html-forward"));
    expect(frame.src).toContain("/sub/two.html");
    bridge(frame, "session-1", { kind: "external", href: "file:///etc/passwd" });
    bridge(frame, "session-1", { kind: "external", href: "https://example.invalid/page" });
    expect(mocks.external).not.toHaveBeenCalled();
    expect(screen.getByTestId("html-external-url")).toHaveTextContent("https://example.invalid/page");
    fireEvent.click(screen.getByTestId("html-external-open"));
    expect(mocks.external).toHaveBeenCalledExactlyOnceWith("https://example.invalid/page");
    fireEvent.click(screen.getByTestId("html-console-clear"));
    expect(screen.queryByText("fixture ready")).toBeNull();
  });

  it("treats same-frame author messages as untrusted and holds only one link until explicit parent consent", async () => {
    render(<HtmlPreview document={doc()} onError={vi.fn()} />);
    const frame = await readyFrame();
    fireEvent.click(screen.getByTestId("html-console-toggle"));
    screen.getByTestId("html-console-toggle").focus();
    bridge(frame, "session-1", { kind: "external", href: "http://localhost/private" });
    expect(screen.queryByTestId("html-external-dialog")).toBeNull();
    bridge(frame, "session-1", { kind: "external", href: "https://first.invalid/path?q=%3Cimg%20src=x%20onerror=alert(1)%3E" });
    bridge(frame, "session-1", { kind: "external", href: "https://replacement.invalid/" });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByTestId("html-external-origin")).toHaveTextContent("https://first.invalid");
    expect(screen.getByTestId("html-external-url").querySelector("img,script")).toBeNull();
    expect(screen.queryByText("https://replacement.invalid/")).toBeNull();
    expect(mocks.external).not.toHaveBeenCalled();
    expect(screen.getByTestId("html-external-cancel")).toHaveFocus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(screen.getByTestId("html-external-open")).toHaveFocus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(screen.getByTestId("html-external-cancel")).toHaveFocus();
    fireEvent.click(screen.getByTestId("html-external-cancel"));
    expect(screen.queryByTestId("html-external-dialog")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("html-console-toggle")).toHaveFocus());
    bridge(frame, "session-1", { kind: "external", href: "https://immediate-spam.invalid/" });
    expect(screen.queryByTestId("html-external-dialog")).toBeNull();
    expect(mocks.external).not.toHaveBeenCalled();
  });

  it("cancels external confirmation on Escape, visibility loss or session replacement", async () => {
    const { rerender } = render(<HtmlPreview document={doc()} onError={vi.fn()} />);
    const frame = await readyFrame();
    bridge(frame, "session-1", { kind: "external", href: "https://example.invalid/" });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("html-external-dialog")).toBeNull();
    expect(mocks.external).not.toHaveBeenCalled();
    // A new renderer tab gets a fresh gate, but hidden previews cannot prompt.
    rerender(<HtmlPreview document={doc({ key: "other-tab" })} onError={vi.fn()} />);
    const nextFrame = await readyFrame();
    bridge(nextFrame, "session-2", { kind: "external", href: "https://example.invalid/" });
    expect(screen.getByTestId("html-external-dialog")).toBeInTheDocument();
    rerender(<HtmlPreview document={doc({ key: "other-tab" })} onError={vi.fn()} visible={false} />);
    expect(screen.queryByTestId("html-external-dialog")).toBeNull();
    bridge(nextFrame, "session-2", { kind: "external", href: "https://background.invalid/" });
    expect(screen.queryByTestId("html-external-dialog")).toBeNull();
    rerender(<HtmlPreview document={doc({ key: "third-tab" })} onError={vi.fn()} />);
    const thirdFrame = await readyFrame();
    bridge(thirdFrame, "session-3", { kind: "external", href: "https://example.invalid/" });
    fireEvent.click(screen.getByTestId("html-refresh"));
    await waitFor(() => expect(screen.queryByTestId("html-external-dialog")).toBeNull());
    expect(mocks.external).not.toHaveBeenCalled();
  });

  it("reports a failed explicitly approved browser launch and never launches twice from one request", async () => {
    const onError = vi.fn();
    mocks.external.mockRejectedValueOnce(new Error("browser launch failed"));
    render(<HtmlPreview document={doc()} onError={onError} />);
    const frame = await readyFrame();
    bridge(frame, "session-1", { kind: "external", href: "https://example.invalid/" });
    const open = screen.getByTestId("html-external-open");
    fireEvent.click(open);
    fireEvent.click(open);
    await waitFor(() => expect(onError).toHaveBeenCalledWith("Error: browser launch failed"));
    expect(mocks.external).toHaveBeenCalledExactlyOnceWith("https://example.invalid/");
  });

  it("regenerates sessions for allow-once, refresh and script policy, then resets on unmount", async () => {
    const { rerender, unmount } = render(<HtmlPreview document={doc()} onError={vi.fn()} />);
    await screen.findByTestId("html-frame");
    fireEvent.click(screen.getByTestId("html-network-allow"));
    await waitFor(() => expect(mocks.open).toHaveBeenLastCalledWith("/docs/report.html", true, true, { proxyMode: "app" }));
    expect(mocks.close).toHaveBeenCalledWith("session-1");
    await screen.findByTestId("html-frame");
    fireEvent.click(screen.getByTestId("html-refresh"));
    await waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(3));
    mocks.preferences = { ...mocks.preferences, htmlScripts: false };
    rerender(<HtmlPreview document={doc()} onError={vi.fn()} />);
    await waitFor(() => expect(mocks.open).toHaveBeenLastCalledWith("/docs/report.html", true, false, { proxyMode: "app" }));
    expect(await screen.findByTestId("html-frame")).toHaveAttribute("sandbox", "allow-scripts");
    unmount();
    render(<HtmlPreview document={doc()} onError={vi.fn()} />);
    await waitFor(() => expect(mocks.open).toHaveBeenLastCalledWith("/docs/report.html", false, false, { proxyMode: "app" }));
  });

  it("asks before one-tab network opt-in when configured and preserves saved/draft distinction", async () => {
    mocks.preferences.htmlNetwork = "ask";
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<HtmlPreview document={doc({ dirty: true })} onError={vi.fn()} />);
    await screen.findByTestId("html-frame");
    fireEvent.click(screen.getByTestId("html-network-allow"));
    expect(confirm).toHaveBeenCalledOnce();
    expect(mocks.open).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("html-save-refresh"));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith("/docs/report.html"));
    confirm.mockRestore();
  });

  it("closes stale late-created tokens and defers initially invisible preview creation", async () => {
    let resolve!: (value: { token: string; url: string }) => void;
    mocks.open.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const { rerender, unmount } = render(<HtmlPreview document={doc()} onError={vi.fn()} visible={false} />);
    expect(mocks.open).not.toHaveBeenCalled();
    rerender(<HtmlPreview document={doc()} onError={vi.fn()} visible />);
    await waitFor(() => expect(mocks.open).toHaveBeenCalledOnce());
    unmount();
    await act(async () => resolve({ token: "late", url: "taomni-preview://localhost/late/report.html" }));
    expect(mocks.close).toHaveBeenCalledWith("late");
  });

  it("keeps Workspace edit scoped and disables it for a read-only temporary copy", async () => {
    const { rerender } = render(<HtmlPreview document={doc()} onError={vi.fn()} workspaceId="workspace-1" />);
    await screen.findByTestId("html-frame");
    fireEvent.click(screen.getByTestId("html-workspace-open"));
    await waitFor(() => expect(mocks.openFile).toHaveBeenCalledWith({ path: "/docs/report.html" }, { context: "viewer", mode: "workspace", workspaceId: "workspace-1" }));
    rerender(<HtmlPreview document={doc({ readOnly: true, readOnlyReason: "Remote temporary copy" })} onError={vi.fn()} workspaceId="workspace-1" />);
    expect(screen.getByTestId("html-workspace-open")).toBeDisabled();
  });

  it("renders browser stub blobs without permitting other blob navigation", async () => {
    mocks.open.mockResolvedValueOnce({ token: "stub", url: "blob:http://localhost:5000/registered" });
    render(<HtmlPreview document={doc()} onError={vi.fn()} />);
    const frame = await readyFrame();
    expect(frame.src).toBe("blob:http://localhost:5000/registered");
    fireEvent.click(screen.getByTestId("html-console-toggle"));
    bridge(frame, "stub", { kind: "navigate", href: "other.html" });
    expect(frame.src).toBe("blob:http://localhost:5000/registered");
    expect(screen.getByTestId("html-console")).toHaveTextContent("Verify local navigation in the native app");
  });

  it("renders actionable failures instead of blank protocol pages", async () => {
    mocks.open.mockRejectedValueOnce(new Error("permission: denied"));
    render(<HtmlPreview document={doc()} onError={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("permission: denied");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show in Explorer" })).toBeInTheDocument();
  });
});
