import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { openMediaResource } from "../frontend/mediaResource.js";

vi.mock("../frontend/mediaResource.js", async (original) => ({
  ...await original(),
  openMediaResource: vi.fn(),
}));

let MediaPlayer;
beforeAll(async () => {
  globalThis.__taomniHost = { React, i18n: { useLocale: () => ({ locale: "en" }) } };
  ({ default: MediaPlayer } = await import("../frontend/index.js"));
});
afterEach(cleanup);

function loadMetadata(player) {
  Object.defineProperties(player, {
    duration: { value: 8, configurable: true },
    videoWidth: { value: 160, configurable: true },
  });
  fireEvent.loadedMetadata(player);
}

it("keeps one playback surface beside the export controls through visibility and compatibility changes", async () => {
  const close = vi.fn();
  vi.mocked(openMediaResource).mockImplementation(async (_source, _mime, attempt) => ({
    url: "blob:" + attempt, close,
  }));
  const source = { name: "sample.mkv", extension: "mkv", saveCopy: vi.fn(), copyExtensions: ["webm"] };
  const view = render(<MediaPlayer document={source} active />);
  const player = await screen.findByTestId("taoffice-media-player");
  expect(player).toHaveAttribute("data-playback", "compatible");
  loadMetadata(player);
  expect(screen.getByTestId("taoffice-media-export-open")).toBeVisible();

  const pause = vi.fn();
  Object.defineProperties(player, { paused: { value: false }, pause: { value: pause } });
  view.rerender(<MediaPlayer document={source} active={false} />);
  expect(pause).toHaveBeenCalledOnce();
  view.rerender(<MediaPlayer document={source} active />);
  expect(screen.getAllByTestId("taoffice-media-player")).toEqual([player]);

  fireEvent.change(screen.getByTestId("taoffice-media-playback-mode"), { target: { value: "stream" } });
  const direct = await screen.findByTestId("taoffice-media-player");
  expect(direct).toHaveAttribute("data-playback", "stream");
  loadMetadata(direct);
  expect(screen.getAllByTestId("taoffice-media-player")).toEqual([direct]);
  expect(player).not.toBeInTheDocument();
  expect(close).toHaveBeenCalledOnce();
  expect(screen.getByTestId("taoffice-media-export-open")).toBeVisible();
});
