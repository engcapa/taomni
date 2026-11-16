import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { resizeFrameHarness } from "../../../test/resizeFrameHarness";
import type { ViewerDocument } from "../../../lib/viewer";
import { MarkdownExportMenu } from "./MarkdownExportMenu";

vi.mock("../viewerLabels", () => ({ useViewerLabels: () => (_zh: string, en: string) => en }));
vi.mock("./markdownExport", () => ({ exportMarkdown: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("keeps export positioning out of resize delivery and disposes closed menu work", () => {
  const frame = resizeFrameHarness();
  let width = 200;
  const measure = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return DOMRect.fromRect(this.tagName === "BUTTON"
      ? { x: 500, y: 100, width: 40, height: 30 }
      : { width, height: 300 });
  });
  const current = { path: "/docs/a.md", content: "# Document", loading: false } as ViewerDocument;
  const view = render(<MarkdownExportMenu document={current} onError={vi.fn()} />);
  fireEvent.click(screen.getByTestId("markdown-export"));
  expect(screen.getByRole("menu")).toHaveStyle({ left: "340px", top: "136px" });
  act(() => frame.flush());
  measure.mockClear();
  width = 300;
  frame.observers[0].notify();
  fireEvent.scroll(window);
  expect(measure).not.toHaveBeenCalled();
  expect(frame.frames.size).toBe(1);
  act(() => frame.flush());
  expect(screen.getByRole("menu")).toHaveStyle({ left: "240px" });
  frame.observers[0].notify();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(frame.frames.size).toBe(0);
  expect(frame.observers[0].disconnect).toHaveBeenCalledOnce();
  expect(screen.getByTestId("markdown-export")).toHaveFocus();
  frame.observers[0].notify();
  expect(frame.frames.size).toBe(0);
  fireEvent.click(screen.getByTestId("markdown-export"));
  expect(screen.getByRole("menu")).toHaveStyle({ left: "240px" });
  view.unmount();
  expect(frame.observers[1].disconnect).toHaveBeenCalledOnce();
  expect(frame.frames.size).toBe(0);
});
