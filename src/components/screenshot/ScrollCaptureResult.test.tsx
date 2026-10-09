import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ScrollCaptureResult } from "./ScrollCaptureResult";

const renderResult = () => render(<ScrollCaptureResult url="data:image/png;base64," width={400} height={2400} frames={4}
  toolbar={null} onCopy={vi.fn()} onSave={vi.fn()} onPin={vi.fn()} onClose={vi.fn()}><span /></ScrollCaptureResult>);
const imageWidth = () => screen.getByTestId("screenshot-scroll-result-image").parentElement!.parentElement!.style.width;

describe("ScrollCaptureResult zoom", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  });

  it("resizes freely with the slider, buttons and Ctrl+wheel", () => {
    renderResult();
    fireEvent.change(screen.getByTestId("screenshot-scroll-zoom"), { target: { value: "50" } });
    expect(imageWidth()).toBe("200px");
    expect(screen.getByTestId("screenshot-scroll-zoom-value")).toHaveTextContent("50%");
    fireEvent.click(screen.getByTestId("screenshot-scroll-zoom-in"));
    expect(imageWidth()).toBe("250px");
    fireEvent.click(screen.getByTestId("screenshot-scroll-zoom-out"));
    expect(imageWidth()).toBe("200px");
    const viewport = screen.getByTestId("screenshot-scroll-result-viewport");
    fireEvent.wheel(viewport, { deltaY: 100 });
    expect(imageWidth()).toBe("200px");
    fireEvent.wheel(viewport, { deltaY: -100, ctrlKey: true });
    expect(parseFloat(imageWidth())).toBeGreaterThan(200);
    fireEvent.click(screen.getByTestId("screenshot-scroll-actual"));
    expect(imageWidth()).toBe("400px");
    fireEvent.keyDown(viewport, { key: "-", ctrlKey: true });
    expect(imageWidth()).toBe("320px");
  });
});
