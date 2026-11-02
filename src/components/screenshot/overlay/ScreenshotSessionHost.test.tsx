import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextScreenshotSession, ScreenshotSessionHost } from "./ScreenshotSessionHost";
import { useScreenshotSessionGeneration } from "./sessionGeneration";

const api = vi.hoisted(() => ({ listen: vi.fn(), begin: vi.fn(), invoke: vi.fn(), discard: vi.fn() }));
vi.mock("./prefetch", () => ({ discardOverlayPrefetch: api.discard }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: api.invoke }));
beforeEach(() => api.invoke.mockResolvedValue({ generation: 7, active: true }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ listen: api.listen }) }));
vi.mock("./startupTiming", () => ({ beginOverlaySession: api.begin }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function Child({ release }: { release: () => void }) {
  const [count, setCount] = useState(0);
  useEffect(() => release, [release]);
  return <button onClick={() => setCount((value) => value + 1)}>selection {count}</button>;
}

describe("native screenshot resident session owner", () => {
  it("disposes an unconsumed cold prefetch on idle and supplies the next child's generation", async () => {
    let handler!: (event: { payload: { generation: number; active: boolean } }) => void;
    api.invoke.mockResolvedValueOnce(null);
    api.listen.mockImplementation((_event, callback) => { handler = callback; return Promise.resolve(vi.fn()); });
    function Generation() { return <span>generation {useScreenshotSessionGeneration()}</span>; }
    render(<ScreenshotSessionHost><Generation /></ScreenshotSessionHost>);
    await waitFor(() => expect(api.discard).toHaveBeenCalledOnce());
    expect(screen.queryByText(/generation/)).not.toBeInTheDocument();
    act(() => handler({ payload: { generation: 8, active: true } }));
    expect(screen.getByText("generation 8")).toBeVisible();
    act(() => handler({ payload: { generation: 8, active: false } }));
    expect(api.discard).toHaveBeenCalledTimes(2);
    act(() => handler({ payload: { generation: 9, active: true } }));
    expect(screen.getByText("generation 9")).toBeVisible();
  });
  it("registers the session listener before initial mount, unmounts on idle, then starts with fresh state", async () => {
    let handler!: (event: { payload: { generation: number; active: boolean } }) => void;
    let installed!: (stop: () => void) => void;
    const stop = vi.fn();
    const release = vi.fn();
    api.listen.mockImplementation((_name, callback) => {
      handler = callback;
      return new Promise<() => void>((resolve) => { installed = resolve; });
    });
    const view = render(<ScreenshotSessionHost><Child release={release} /></ScreenshotSessionHost>);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    await act(async () => installed(stop));
    fireEvent.click(await screen.findByRole("button"));
    expect(screen.getByRole("button")).toHaveTextContent("selection 1");
    act(() => handler({ payload: { generation: 7, active: false } }));
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(release).toHaveBeenCalledOnce();
    act(() => handler({ payload: { generation: 8, active: true } }));
    expect(screen.getByRole("button")).toHaveTextContent("selection 0");
    act(() => handler({ payload: { generation: 7, active: false } }));
    expect(screen.getByRole("button")).toHaveTextContent("selection 0");
    view.unmount();
    expect(stop).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("releases late listener registrations across StrictMode and actual unmount", async () => {
    const stops = [vi.fn(), vi.fn()];
    const completions: ((stop: () => void) => void)[] = [];
    api.listen.mockImplementation(() => new Promise<() => void>((resolve) => completions.push(resolve)));
    const view = render(<StrictMode><ScreenshotSessionHost>ready</ScreenshotSessionHost></StrictMode>);
    expect(completions).toHaveLength(2);
    await act(async () => { completions[0](stops[0]); completions[1](stops[1]); });
    await screen.findByText("ready");
    expect(stops[0]).toHaveBeenCalledOnce();
    view.unmount();
    await waitFor(() => expect(stops[1]).toHaveBeenCalledOnce());
  });

  it("keeps prewarm empty and does not let a stale snapshot replace a newer trigger", async () => {
    let handler!: (event: { payload: { generation: number; active: boolean } }) => void;
    let snapshot!: (value: { generation: number; active: boolean } | null) => void;
    api.listen.mockImplementation((_event, callback) => { handler = callback; return Promise.resolve(vi.fn()); });
    api.invoke.mockReturnValueOnce(new Promise((resolve) => { snapshot = resolve; }));
    render(<ScreenshotSessionHost><Child release={vi.fn()} /></ScreenshotSessionHost>);
    await waitFor(() => expect(api.invoke).toHaveBeenCalledOnce());
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    act(() => handler({ payload: { generation: 9, active: true } }));
    await act(async () => snapshot(null));
    expect(screen.getByRole("button")).toHaveTextContent("selection 0");
  });

  it("rejects stale activation, duplicate delivery and invalid generations", () => {
    const idle = { generation: 8, active: false };
    expect(nextScreenshotSession(idle, { generation: 8, active: true })).toBe(idle);
    expect(nextScreenshotSession(idle, { generation: 7, active: true })).toBe(idle);
    expect(nextScreenshotSession(idle, { generation: 8, active: false })).toBe(idle);
    expect(nextScreenshotSession(idle, { generation: NaN, active: true })).toBe(idle);
    expect(nextScreenshotSession(idle, { generation: 9, active: true })).toEqual({ generation: 9, active: true });
  });
});
