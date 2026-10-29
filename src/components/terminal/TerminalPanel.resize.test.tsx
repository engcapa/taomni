import "./tests/terminalPanel/harness";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TerminalPanel } from "./TerminalPanel";
import { fitMocks, ipcMocks, terminalMocks } from "./tests/terminalPanel/harness";

class ObservedResize {
  static instances: ObservedResize[] = [];
  element: Element | null = null;
  disconnect = vi.fn();
  constructor(readonly callback: ResizeObserverCallback) { ObservedResize.instances.push(this); }
  observe(element: Element) { this.element = element; }
  notify() { this.callback([], this as unknown as ResizeObserver); }
}

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  ObservedResize.instances = [];
  terminalMocks.terminalCtor.mockClear();
  ipcMocks.resizeTerminal.mockClear();
  ipcMocks.createTerminalSessionId.mockImplementation(() => "resize-session");
  ipcMocks.createLocalTerminal.mockImplementation(async (sessionId: string) => ({ sessionId, shellId: "default" }));
  fitMocks.fit.mockReset();
  vi.stubGlobal("ResizeObserver", ObservedResize);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 16));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  fitMocks.fit.mockReset();
});

async function terminal() {
  const rendered = render(<TerminalPanel tabId="resize" visible />);
  await act(async () => {});
  const host = rendered.container.querySelector<HTMLElement>(".terminal-host")!;
  let width = 800;
  Object.defineProperties(host, {
    clientWidth: { get: () => width, configurable: true },
    clientHeight: { value: 300, configurable: true },
  });
  const term = terminalMocks.terminalCtor.mock.results.at(-1)!.value;
  fitMocks.fit.mockImplementation(() => { term.cols = Math.floor(width / 10); term.rows = 15; });
  act(() => vi.advanceTimersByTime(150));
  fitMocks.fit.mockClear();
  ipcMocks.resizeTerminal.mockClear();
  const observer = ObservedResize.instances.find((item) => item.element === host)!;
  return { ...rendered, observer, width: (value: number) => { width = value; } };
}

it("fits a moved terminal and synchronizes the latest PTY size on the next frame", async () => {
  const rendered = await terminal();
  act(() => {
    rendered.width(300);
    rendered.observer.notify();
    rendered.width(1000);
    rendered.observer.notify();
    vi.advanceTimersByTime(16);
  });
  expect(fitMocks.fit).toHaveBeenCalledTimes(1);
  expect(ipcMocks.resizeTerminal).toHaveBeenLastCalledWith("resize-session", 100, 15);
  expect(ipcMocks.createLocalTerminal).toHaveBeenCalledTimes(1);
});

it("cancels a pending resize when its terminal is destroyed", async () => {
  const rendered = await terminal();
  act(() => rendered.observer.notify());
  rendered.unmount();
  act(() => vi.advanceTimersByTime(150));
  expect(fitMocks.fit).not.toHaveBeenCalled();
  expect(ipcMocks.resizeTerminal).not.toHaveBeenCalled();
  expect(rendered.observer.disconnect).toHaveBeenCalled();
});
