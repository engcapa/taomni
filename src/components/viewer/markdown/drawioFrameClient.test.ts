import { afterEach, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../../../lib/runtime", () => ({ isTauriRuntime: () => true }));

const rendererUrl = "http://127.0.0.1:43210/_drawio-renderer/0123456789abcdef0123456789abcdef/index.html";

function send(frame: HTMLIFrameElement, data: object) {
  window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, data }));
}

afterEach(() => {
  document.querySelectorAll("[data-drawio-renderer]").forEach((frame) => frame.remove());
  invoke.mockReset();
  vi.restoreAllMocks();
  vi.resetModules();
});

it("renders diagrams through one sandboxed native frame", async () => {
  invoke.mockResolvedValue(rendererUrl);
  const { renderInDrawioFrame } = await import("./drawioFrameClient");
  const model = document.implementation.createDocument("", "mxGraphModel").documentElement;

  const first = renderInDrawioFrame(model, true);
  const second = renderInDrawioFrame(model, false);
  const frame = await waitFor(() => {
    const frame = document.querySelector<HTMLIFrameElement>("iframe[data-drawio-renderer]");
    expect(frame).not.toBeNull();
    return frame!;
  });
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  expect(frame.src).toBe(rendererUrl);
  expect(frame.srcdoc).toBe("");
  expect(invoke).toHaveBeenCalledExactlyOnceWith("viewer_drawio_renderer_url");

  const messages = vi.spyOn(frame.contentWindow!, "postMessage");
  send(frame, { type: "drawio-ready" });
  await waitFor(() => expect(messages).toHaveBeenCalledTimes(2));
  expect(messages.mock.calls[0][0]).toMatchObject({ type: "drawio-render", id: 1, rich: true });
  expect(messages.mock.calls[1][0]).toMatchObject({ type: "drawio-render", id: 2, rich: false });
  send(frame, { type: "drawio-result", id: 2, svg: "<svg>plain</svg>" });
  send(frame, { type: "drawio-result", id: 1, svg: "<svg>rich</svg>" });
  await expect(Promise.all([first, second])).resolves.toEqual(["<svg>rich</svg>", "<svg>plain</svg>"]);
});

it("retries the next render after an invalid native URL without opening it", async () => {
  invoke.mockResolvedValueOnce("http://example.com/_drawio-renderer/0123456789abcdef0123456789abcdef/index.html")
    .mockResolvedValueOnce(rendererUrl);
  const { renderInDrawioFrame } = await import("./drawioFrameClient");
  const model = document.createElement("mxGraphModel");
  await expect(renderInDrawioFrame(model, true)).rejects.toThrow("Invalid bundled draw.io renderer URL");
  expect(document.querySelector("iframe[data-drawio-renderer]")).toBeNull();

  const retried = renderInDrawioFrame(model, true);
  const rejected = expect(retried).rejects.toThrow("Script unavailable");
  await waitFor(() => {
    const frame = document.querySelector<HTMLIFrameElement>("iframe[data-drawio-renderer]");
    expect(frame?.src).toBe(rendererUrl);
    send(frame!, { type: "drawio-error", error: "Script unavailable" });
  });
  await rejected;
  expect(document.querySelector("iframe[data-drawio-renderer]")).toBeNull();
});
