import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { convertInWebView, validClip } from "../frontend/conversion.js";

vi.mock("../frontend/conversion.js", async (original) => ({
  ...await original(),
  convertInWebView: vi.fn(),
}));

let VideoExport;
beforeAll(async () => {
  globalThis.__taomniHost = { React };
  ({ VideoExport } = await import("../frontend/VideoExport.js"));
});
beforeEach(() => { vi.mocked(convertInWebView).mockReset(); });
afterEach(cleanup);

const byId = (name) => screen.getByTestId("taoffice-media-" + name);

function openExport(saveCopy = vi.fn()) {
  render(<>
    <button type="button" data-testid="outside-export">Outside export</button>
    <VideoExport source={{ saveCopy, copyExtensions: ["mp4", "webm"] }} formats={["webm", "mp4"]}
      makeFile={async () => new Blob(["source"])} canNative={false}
      duration={8.008} naturalWidth={160} seek={vi.fn()} label={(_zh, en) => en} />
  </>);
  fireEvent.click(byId("export-open"));
  return saveCopy;
}

it("accepts exact millisecond trims and rejects blank, reversed or out-of-range times", () => {
  expect(validClip("2.501", "2.502", 8.008)).toBe(true);
  expect(validClip("0", "8.008", 8.008)).toBe(true);
  for (const [start, end] of [["", "8"], ["-1", "1"], ["1", "1"], ["5", "2"], ["0", "8.009"], ["2.0001", "3"]]) {
    expect(validClip(start, end, 8.008)).toBe(false);
  }
});

it("blocks invalid submission, respects composing keys and returns focus after Escape", () => {
  const saveCopy = openExport();
  const end = byId("trim-end");
  expect(document.activeElement).toBe(byId("trim-start"));
  fireEvent.change(end, { target: { value: "" } });
  expect(byId("export-save")).toBeDisabled();
  expect(end).toHaveAttribute("aria-invalid", "true");
  expect(document.getElementById(end.getAttribute("aria-describedby"))).toBe(byId("export-invalid"));
  fireEvent.submit(byId("export"));
  expect(convertInWebView).not.toHaveBeenCalled();
  fireEvent.change(end, { target: { value: "5" } });
  expect(fireEvent.keyDown(end, { key: "Enter", isComposing: true })).toBe(false);
  fireEvent.keyDown(end, { key: "Escape", isComposing: true });
  expect(byId("export")).toBeVisible();
  fireEvent.keyDown(end, { key: "Escape" });
  expect(screen.queryByTestId("taoffice-media-export")).toBeNull();
  expect(document.activeElement).toBe(byId("export-open"));
  expect(saveCopy).not.toHaveBeenCalled();
});

it("cancels in-flight work and keeps the form, selections and retry focus", async () => {
  const saveCopy = openExport();
  vi.mocked(convertInWebView).mockImplementation((_file, _options, signal) =>
    new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })));
  fireEvent.change(byId("trim-start"), { target: { value: "2" } });
  fireEvent.change(byId("export-format"), { target: { value: "mp4" } });
  fireEvent.submit(byId("export"));
  await waitFor(() => expect(convertInWebView).toHaveBeenCalledOnce());
  expect(byId("export-save")).toHaveAttribute("aria-busy", "true");
  expect(document.activeElement).toBe(byId("export-cancel"));
  fireEvent.keyDown(byId("export-cancel"), { key: "Escape" });
  await waitFor(() => expect(byId("export-save")).toBeEnabled());
  expect(document.activeElement).toBe(byId("export-save"));
  expect(byId("trim-start")).toHaveValue(2);
  expect(byId("export-format")).toHaveValue("mp4");
  expect(saveCopy).not.toHaveBeenCalled();
});

it("keeps focus moved away by the user when a copy finishes saving", async () => {
  let finishSave;
  const saveCopy = openExport(vi.fn(() => new Promise((resolve) => { finishSave = resolve; })));
  vi.mocked(convertInWebView).mockResolvedValue({ arrayBuffer: async () => new Uint8Array([10, 23]).buffer });
  fireEvent.change(byId("export-format"), { target: { value: "mp4" } });
  fireEvent.submit(byId("export"));
  await waitFor(() => expect(saveCopy).toHaveBeenCalledWith(new Uint8Array([10, 23]), { extension: "mp4" }));
  const outside = screen.getByTestId("outside-export");
  outside.focus();
  finishSave("output.mp4");
  await waitFor(() => expect(byId("export-saved")).toHaveTextContent("Video copy saved."));
  expect(document.activeElement).toBe(outside);
});
