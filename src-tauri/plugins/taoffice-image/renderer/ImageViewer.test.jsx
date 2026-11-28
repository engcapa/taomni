import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { readImagePreview } from "./imagePreview.js";

vi.mock("./imagePreview.js", () => ({ readImagePreview: vi.fn() }));

let ImageViewer;
let createUrl;
let revokeUrl;
const preview = { width: 96, height: 64, blob: new Blob(["preview"]) };
const source = (name) => ({ name, openSystem: vi.fn() });

beforeAll(async () => {
  globalThis.__taomniHost = { React, i18n: { useLocale: () => ({ locale: "en" }) } };
  ({ default: ImageViewer } = await import("./ImageViewer.jsx"));
});
beforeEach(() => {
  readImagePreview.mockReset();
  createUrl = vi.fn(() => "blob:thumbnail");
  revokeUrl = vi.fn();
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = createUrl;
    static revokeObjectURL = revokeUrl;
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("keeps camera pixels and zoom local to the open document and releases the image when closed", async () => {
  readImagePreview.mockResolvedValue(preview);
  const view = render(<ImageViewer document={source("first.dng")}/>);
  const img = await screen.findByRole("img", { name: "first.dng" });
  expect(screen.getByText("96 × 64")).toBeVisible();
  fireEvent.change(screen.getByRole("combobox", { name: "Zoom" }), { target: { value: "200" } });
  expect(img).toHaveStyle({ width: "192px" });
  view.rerender(<ImageViewer document={source("second.psd")}/>);
  await screen.findByRole("img", { name: "second.psd" });
  expect(revokeUrl).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("combobox")).toHaveValue("fit");
  view.unmount();
  expect(revokeUrl).toHaveBeenCalledTimes(2);
});

it("aborts stale decoding and ignores its late result after switching files", async () => {
  let finish;
  readImagePreview.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const view = render(<ImageViewer document={source("slow.heic")}/>);
  const signal = readImagePreview.mock.calls[0][1];
  readImagePreview.mockResolvedValueOnce(preview);
  view.rerender(<ImageViewer document={source("new.psd")}/>);
  expect(signal.aborted).toBe(true);
  await screen.findByRole("img", { name: "new.psd" });
  await act(async () => finish(preview));
  expect(createUrl).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("img")).toHaveAccessibleName("new.psd");
});

it("reports the decode failure and failed system open, then re-reads the document on retry", async () => {
  const photo = source("changed.nef");
  photo.openSystem.mockRejectedValue(new Error("No association"));
  readImagePreview.mockRejectedValueOnce(new Error("No embedded preview")).mockResolvedValueOnce(preview);
  render(<ImageViewer document={photo}/>);
  expect(await screen.findByRole("alert")).toHaveTextContent("No embedded preview");
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", Object.assign(Object.create(navigator), { clipboard: { writeText } }));
  fireEvent.click(screen.getByRole("button", { name: "Copy error details" }));
  await screen.findByText("Error details copied.");
  expect(writeText).toHaveBeenCalledWith("No embedded preview");
  fireEvent.click(screen.getByRole("button", { name: "Open in system app" }));
  await screen.findByText(/No association/);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByRole("img", { name: photo.name });
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  expect(readImagePreview).toHaveBeenCalledTimes(2);
});
