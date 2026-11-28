import * as React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { decodeVisio } from "./visioDocument.js";
import { exportVisioPdf } from "./visioPdf.js";

vi.mock("./visioDocument.js", () => ({ decodeVisio: vi.fn() }));
vi.mock("./visioPdf.js", () => ({ exportVisioPdf: vi.fn() }));
vi.mock("./visioPackage.js", () => ({ saveVisioCopy: () => new Uint8Array([42]) }));
vi.mock("./VisioShapes.jsx", () => ({
  VisioShapes: ({ onPreview }) => <button onClick={() => onPreview(new Map([["shape", "draft"]]))}>Change shape</button>,
}));

const page = name => ({ name, svg: name, text: name, width: 96, height: 72 });
const pages = [page("First"), page("Second")];
const label = (_zh, en) => en;
let VisioPages;

beforeAll(async () => {
  vi.stubGlobal("__taomniHost", { React });
  ({ VisioPages } = await import("./VisioPages.jsx"));
  vi.unstubAllGlobals();
});
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("URL", Object.assign(class {}, { createObjectURL: () => "blob:diagram", revokeObjectURL: () => {} }));
  HTMLElement.prototype.scrollTo = vi.fn();
  vi.mocked(exportVisioPdf).mockReset().mockResolvedValue(new Uint8Array([3, 4]));
  vi.mocked(decodeVisio).mockReset();
});
afterEach(() => {
  cleanup();
  delete HTMLElement.prototype.scrollTo;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function open(copyExtensions, saveCopy) {
  return render(<VisioPages initialPages={pages} source={{ copyExtensions, saveCopy }} active label={label} />);
}

const byId = id => screen.getByTestId("taoffice-visio-" + id);
const query = id => screen.queryByTestId("taoffice-visio-" + id);

it("exposes only the export formats granted by this core and document", () => {
  const old = open(["svg"], vi.fn());
  expect(byId("export")).toBeEnabled();
  expect(query("export-pdf")).toBeNull();
  old.unmount();
  open(undefined, undefined);
  expect(query("export")).toBeNull();
  expect(query("export-pdf")).toBeNull();
});

it("exports the initiating page once, clears cancelled output and permits retry after a save failure", async () => {
  let finish;
  const save = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockRejectedValueOnce(new Error("Destination exists")).mockResolvedValueOnce("review.pdf");
  open(["svg", "pdf"], save);
  fireEvent.click(byId("export-pdf"));
  await waitFor(() => expect(save).toHaveBeenCalledWith(new Uint8Array([3, 4]), { extension: "pdf" }));
  expect(byId("export-pdf")).toHaveAttribute("aria-busy", "true");
  expect(byId("export")).toBeDisabled();
  fireEvent.click(byId("export"));
  fireEvent.click(byId("next"));
  expect(exportVisioPdf).toHaveBeenCalledExactlyOnceWith(pages[0]);
  expect(save).toHaveBeenCalledOnce();
  act(() => finish(null));
  await waitFor(() => expect(byId("export-pdf")).toBeEnabled());
  expect(query("export-status")).toBeNull();
  expect(query("export-error")).toBeNull();
  fireEvent.click(byId("export-pdf"));
  await waitFor(() => expect(byId("export-error")).toHaveTextContent("Destination exists"));
  fireEvent.click(byId("export-pdf"));
  await waitFor(() => expect(byId("export-status")).toHaveTextContent("PDF exported. review.pdf"));
  expect(exportVisioPdf).toHaveBeenLastCalledWith(pages[1]);
  expect(query("export-error")).toBeNull();
});

it("blocks pending or failed draft previews and exports the recovered draft", async () => {
  vi.mocked(decodeVisio).mockRejectedValueOnce(new Error("preview")).mockResolvedValueOnce([page("Edited first"), pages[1]]);
  const save = vi.fn().mockResolvedValue("draft.pdf");
  open(["pdf"], save);
  const edit = screen.getByRole("button", { name: "Change shape" });
  fireEvent.click(edit);
  expect(byId("export-pdf")).toBeDisabled();
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not preview the edits");
  expect(byId("export-pdf")).toBeDisabled();
  fireEvent.click(edit);
  await waitFor(() => expect(byId("export-pdf")).toBeEnabled());
  fireEvent.click(byId("export-pdf"));
  await waitFor(() => expect(byId("export-status")).toHaveTextContent("draft.pdf"));
  expect(exportVisioPdf).toHaveBeenCalledExactlyOnceWith(page("Edited first"));
});
