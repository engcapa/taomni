import { act, cleanup, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorMountBoundary } from "./EditorMountBoundary";

const frames = new Map<number, FrameRequestCallback>();
let sequence = 0;
beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++sequence, callback);
    return sequence;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});
afterEach(() => { cleanup(); frames.clear(); vi.unstubAllGlobals(); });
const paint = () => act(() => {
  const callbacks = [...frames.values()];
  frames.clear();
  callbacks.forEach((callback) => callback(1));
});

it("yields initial construction, mounts the current file and retains its editor on subsequent updates", () => {
  const mount = vi.fn(), unmount = vi.fn();
  function Editor({ file }: { file: string }) {
    useEffect(() => { mount(); return unmount; }, []);
    return <div>{file}</div>;
  }
  const { rerender } = render(<EditorMountBoundary><Editor file="first" /></EditorMountBoundary>);
  expect(screen.getByRole("status", { name: "Loading editor" })).toHaveAttribute("aria-busy", "true");
  expect(mount).not.toHaveBeenCalled();
  rerender(<EditorMountBoundary><Editor file="second" /></EditorMountBoundary>);
  paint();
  expect(screen.getByText("second")).toBeVisible();
  expect(screen.queryByText("first")).not.toBeInTheDocument();
  rerender(<EditorMountBoundary><Editor file="third" /></EditorMountBoundary>);
  expect(screen.getByText("third")).toBeVisible();
  expect(mount).toHaveBeenCalledTimes(1);
  expect(unmount).not.toHaveBeenCalled();
  expect(frames.size).toBe(0);
});

it("cancels a pending editor when its pane closes before the measurement frame", () => {
  const renderEditor = vi.fn();
  function Editor() { renderEditor(); return <div>Closed file</div>; }
  const { unmount } = render(<EditorMountBoundary><Editor /></EditorMountBoundary>);
  unmount();
  expect(frames.size).toBe(0);
  paint();
  expect(renderEditor).not.toHaveBeenCalled();
});
