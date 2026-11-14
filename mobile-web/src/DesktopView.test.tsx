import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "./api";

const mock = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./api", async original => ({ ...await original<typeof import("./api")>(), request: mock.request }));

import { DesktopView } from "./DesktopView";

const instance = { id: "pc", deviceId: "phone", label: "PC", endpoint: "https://pc.example", token: "t" };

const sampleScreen = (revision = 1) => ({
  mime: "image/png",
  width: 800,
  height: 500,
  screen_width: 1920,
  screen_height: 1200,
  display_id: "display-1",
  display_name: "Built-in",
  displays: [{ id: "display-1", name: "Built-in", width: 1920, height: 1200, primary: true }],
  captured_at: 1700000000 + revision,
  image_b64: btoa(`png-rev-${revision}`),
});

beforeEach(() => { mock.request.mockReset(); });
afterEach(cleanup);

it("blocks screen image behind settings opt-in and displays live screen once enabled", async () => {
  let allowed = false;
  let seq = 0;
  mock.request.mockImplementation(async (_inst, path: string) => {
    if (path.startsWith("/desktop/screen")) {
      if (!allowed) throw new ApiError("screen_capture_disabled");
      return sampleScreen(++seq);
    }
    if (path === "/desktop/windows") {
      return {
        windows: [{
          id: "win:1", title: "Terminal", app_name: "Taomni", pid: 100,
          x: 0, y: 0, width: 800, height: 600, minimized: false, focused: true, kind: "desktop",
        }],
        screen_capture_enabled: allowed,
      };
    }
    throw new Error(`unexpected path: ${path}`);
  });

  render(<DesktopView instance={instance} />);
  expect(await screen.findByTestId("mobile-screen-disabled")).toHaveTextContent("移动服务");
  expect(screen.queryByTestId("mobile-screen-image")).toBeNull();

  allowed = true;
  fireEvent.click(screen.getByTestId("mobile-desktop-refresh"));
  const img = await screen.findByTestId("mobile-screen-image");
  expect(img).toHaveAttribute("src", `data:image/png;base64,${btoa("png-rev-1")}`);
  expect(screen.getByTestId("mobile-screen-meta")).toHaveTextContent("Built-in");
});

it("opens server browser URL, selects opened browser window, and sends window input + shortcut keys", async () => {
  let screenSeq = 0;
  let browserOpened = false;
  const inputs: { path: string; body: unknown }[] = [];
  mock.request.mockImplementation(async (_inst, path: string, body?: unknown) => {
    if (path.startsWith("/desktop/screen")) {
      return sampleScreen(++screenSeq);
    }
    if (path === "/desktop/windows") {
      const base = [{
        id: "win:1", title: "Editor", app_name: "Code", pid: 10,
        x: 0, y: 0, width: 600, height: 400, minimized: false, focused: false, kind: "desktop",
      }];
      return {
        windows: browserOpened
          ? [{
              id: "tauri:mobile-remote-browser",
              title: "Taomni Browser - http://127.0.0.1:3000",
              app_name: "Taomni",
              pid: 20,
              x: 0,
              y: 0,
              width: 1120,
              height: 760,
              minimized: false,
              focused: true,
              kind: "tauri_browser",
            }, ...base]
          : base,
        screen_capture_enabled: true,
      };
    }
    if (path === "/desktop/browser") {
      browserOpened = true;
      const url = (body as { url: string }).url;
      return {
        ok: true,
        url,
        window_id: "tauri:mobile-remote-browser",
        title: `Taomni Browser - ${url}`,
        screen_capture_enabled: true,
      };
    }
    if (path.startsWith("/desktop/windows/") && path.endsWith("/input")) {
      inputs.push({ path, body });
      return {
        ok: true,
        window_id: "tauri:mobile-remote-browser",
        title: "Taomni Browser - http://127.0.0.1:3000",
      };
    }
    throw new Error(`unexpected path: ${path}`);
  });

  render(<DesktopView instance={instance} initialScreenEnabled />);
  await screen.findByTestId("mobile-screen-image");

  fireEvent.change(screen.getByTestId("mobile-browser-url"), { target: { value: "http://127.0.0.1:3000" } });
  fireEvent.click(screen.getByTestId("mobile-browser-open"));
  expect(await screen.findByTestId("mobile-browser-status")).toHaveTextContent("http://127.0.0.1:3000");

  await waitFor(() => {
    expect(screen.getByTestId("mobile-window-select")).toHaveValue("tauri:mobile-remote-browser");
  });

  fireEvent.change(screen.getByTestId("mobile-window-input"), { target: { value: "search query" } });
  fireEvent.click(screen.getByTestId("mobile-window-send"));
  expect(await screen.findByTestId("mobile-window-result")).toHaveTextContent("已发送文本");
  expect(inputs[0]).toEqual({
    path: "/desktop/windows/tauri%3Amobile-remote-browser/input",
    body: { text: "search query", submit: true },
  });

  fireEvent.click(screen.getByTestId("mobile-window-key-f5"));
  expect(await screen.findByTestId("mobile-window-result")).toHaveTextContent("f5");
  expect(inputs[1]).toEqual({
    path: "/desktop/windows/tauri%3Amobile-remote-browser/input",
    body: { text: "", key: "f5", submit: false },
  });
  expect(screenSeq).toBeGreaterThanOrEqual(3);
});
