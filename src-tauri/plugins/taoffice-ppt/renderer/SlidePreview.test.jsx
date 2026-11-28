import * as React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

const channels = [];
const createObjectURL = vi.fn(() => "blob:rendered-slide");
const revokeObjectURL = vi.fn();
const bytes = new Uint8Array([1, 2, 3]);

let SlidePreview;
beforeAll(async () => {
  vi.stubGlobal("__taomniHost", { React });
  ({ SlidePreview } = await import("./SlidePreview.jsx"));
  vi.unstubAllGlobals();
});

beforeEach(() => {
  channels.length = 0;
  vi.stubGlobal("MessageChannel", class {
    port1 = { postMessage: vi.fn(), close: vi.fn() };
    port2 = { close: vi.fn() };
    constructor() { channels.push(this); }
  });
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = createObjectURL;
    static revokeObjectURL = revokeObjectURL;
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function slide(index) {
  return <SlidePreview bytes={bytes} slide={index} width={1440} height={810}
    description={`Slide ${index + 1}`} label={(_zh, en) => en} />;
}

function receive(channel, data) {
  act(() => channel.port1.onmessage({ data }));
}

function renderSlide(channel, index) {
  receive(channel, { ready: true });
  const [request, transfers] = channel.port1.postMessage.mock.lastCall;
  expect(request.index).toBe(index);
  expect(new Uint8Array(request.bytes)).toEqual(bytes);
  expect(transfers).toEqual([request.bytes]);
  return request.id;
}

function assertRendered(channel, id, name) {
  receive(channel, { id, image: new Blob(["rendered slide"]) });
  const image = screen.getByRole("img", { name });
  fireEvent.load(image);
  expect(image).toHaveAttribute("data-image-ready", "true");
}

it("starts a new renderer when the user navigates away from a failed slide", () => {
  const { rerender } = render(slide(0));
  const failed = channels[0];
  receive(failed, { id: renderSlide(failed, 0), failed: true });
  expect(screen.getByRole("alert")).toHaveTextContent("Could not display the slide.");
  expect(failed.port1.close).toHaveBeenCalledOnce();

  rerender(slide(1));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(channels).toHaveLength(2);
  const replacement = channels[1];
  assertRendered(replacement, renderSlide(replacement, 1), "Slide 2");
});

it("restarts on the requested slide when an abandoned slide times out", () => {
  vi.useFakeTimers();
  const { rerender } = render(slide(0));
  const abandoned = channels[0];
  const oldId = renderSlide(abandoned, 0);
  rerender(slide(1));
  act(() => vi.advanceTimersByTime(25_000));

  expect(screen.queryByRole("alert")).toBeNull();
  expect(channels).toHaveLength(2);
  receive(abandoned, { id: oldId, image: new Blob(["abandoned slide"]) });
  expect(screen.queryByRole("img")).toBeNull();
  const replacement = channels[1];
  assertRendered(replacement, renderSlide(replacement, 1), "Slide 2");
});

it("allows the user to retry the failed slide without leaving it", () => {
  render(slide(0));
  const failed = channels[0];
  receive(failed, { id: renderSlide(failed, 0), failed: true });
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(screen.queryByRole("alert")).toBeNull();
  const replacement = channels[1];
  assertRendered(replacement, renderSlide(replacement, 0), "Slide 1");
});
