import * as React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  AnnotationMode: { ENABLE_STORAGE: 3 },
  TextLayer: class {
    constructor({ container }) {
      const text = document.createElement("span");
      text.textContent = "Quarterly report";
      container.appendChild(text);
      this.textDivs = [text];
    }
    render() { return Promise.resolve(); }
    cancel() {}
  },
}));

let PdfPage;
beforeAll(async () => {
  vi.stubGlobal("__taomniHost", { React });
  ({ PdfPage } = await import("./PdfPage.jsx"));
  vi.unstubAllGlobals();
});
afterEach(cleanup);

it("repaints form storage without recreating the text layer or moving focus", async () => {
  const cancel = vi.fn();
  const page = {
    rotate: 0,
    getViewport: ({ scale }) => ({ width: 420 * scale, height: 300 * scale }),
    render: vi.fn(() => ({ cancel, promise: Promise.resolve() })),
    streamTextContent: vi.fn(),
  };
  const pdf = { getPage: vi.fn().mockResolvedValue(page) };
  const props = { pdf, number: 1, zoom: 1, rotation: 0, viewportWidth: 0,
    highlight: "quarterly", onScale: vi.fn(), label: (_zh, en) => en };
  const preview = (formRevision) => <>
    <input aria-label="Contact" />
    <PdfPage {...props} formRevision={formRevision} />
  </>;
  const { rerender } = render(preview(0));
  await waitFor(() => expect(screen.getByTestId("taoffice-pdf-page")).toHaveAttribute("data-ready", "true"));
  const text = screen.getByText("Quarterly report");
  const input = screen.getByLabelText("Contact");
  input.focus();
  rerender(preview(1));
  await waitFor(() => expect(page.render).toHaveBeenCalledTimes(2));
  expect(page.render.mock.calls[1][0]).toMatchObject({ annotationMode: 3, canvas: page.render.mock.calls[0][0].canvas });
  expect(pdf.getPage).toHaveBeenCalledOnce();
  expect(page.streamTextContent).toHaveBeenCalledOnce();
  expect(screen.getByText("Quarterly report")).toBe(text);
  expect(text).toHaveAttribute("data-search-hit");
  expect(input).toHaveFocus();
  expect(cancel).toHaveBeenCalledOnce();
});
