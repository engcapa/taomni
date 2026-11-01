import { cleanup, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ScreenshotBaseImage } from "./ScreenshotBaseImage";

afterEach(cleanup);

describe("decoded screenshot background", () => {
  it("commits the already decoded node itself instead of starting a second image", () => {
    const image = document.createElement("img");
    image.src = "blob:decoded";
    const view = render(<StrictMode><ScreenshotBaseImage image={image} width={1000} height={750} /></StrictMode>);
    expect(screen.getByTestId("screenshot-base-image")).toBe(image);
    expect(image.style.width).toBe("1000px");
    view.rerender(<StrictMode><ScreenshotBaseImage image={image} width={800} height={600} /></StrictMode>);
    expect(image.style.height).toBe("600px");
    expect(document.querySelectorAll('[data-testid="screenshot-base-image"]')).toHaveLength(1);
    view.unmount();
    expect(image.isConnected).toBe(false);
  });
});
