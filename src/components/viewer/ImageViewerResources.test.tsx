import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useImageDimensions } from "./ImageViewerResources";

function Dimensions({ url, cached }: { url: string; cached: boolean }) {
  const { image, dimensions } = useImageDimensions(url);
  return <><img key={url} src={url} ref={(node) => {
    image.current = node;
    if (node) {
      Object.defineProperty(node, "complete", { configurable: true, value: cached });
      Object.defineProperty(node, "naturalWidth", { configurable: true, value: cached ? 640 : 0 });
      Object.defineProperty(node, "naturalHeight", { configurable: true, value: cached ? 360 : 0 });
    }
  }} /><output data-testid="dimensions">{dimensions.width}×{dimensions.height}</output></>;
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe("current image decode ownership", () => {
  it("adopts a cached image completed before passive effects and clears a new pending image", () => {
    const view = render(<Dimensions url="blob:cached" cached />);
    expect(screen.getByTestId("dimensions")).toHaveTextContent("640×360");
    view.rerender(<Dimensions url="blob:pending" cached={false} />);
    expect(screen.getByTestId("dimensions")).toHaveTextContent("0×0");
    view.rerender(<Dimensions url="blob:cached-again" cached />);
    expect(screen.getByTestId("dimensions")).toHaveTextContent("640×360");
  });
});
