import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OVERVIEW_PREVIEW_DELAY_MS, useOverviewPreview } from "./useOverviewPreview";

function makeCard(id: string): HTMLButtonElement {
  const card = document.createElement("button");
  card.dataset.testid = "tab-overview-card";
  card.dataset.tabId = id;
  document.body.append(card);
  return card;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("useOverviewPreview", () => {
  it("uses a hover dwell inside the 0.5-1 s convention", () => {
    expect(OVERVIEW_PREVIEW_DELAY_MS).toBeGreaterThanOrEqual(500);
    expect(OVERVIEW_PREVIEW_DELAY_MS).toBeLessThanOrEqual(1_000);
  });

  it("waits for the dwell time before enlarging the hovered card", () => {
    const card = makeCard("first");
    const { result } = renderHook(() => useOverviewPreview());
    act(() => result.current.hover("first", card));
    expect(result.current.preview).toBeNull();

    act(() => vi.advanceTimersByTime(OVERVIEW_PREVIEW_DELAY_MS - 1));
    expect(result.current.preview).toBeNull();

    act(() => vi.advanceTimersByTime(1));
    expect(result.current.preview?.id).toBe("first");
    expect(result.current.preview?.bounds).toEqual(card.getBoundingClientRect());
  });

  it("cancels a pending enlargement when the pointer leaves before the dwell", () => {
    const card = makeCard("first");
    const { result } = renderHook(() => useOverviewPreview());
    act(() => result.current.hover("first", card));
    act(() => vi.advanceTimersByTime(OVERVIEW_PREVIEW_DELAY_MS / 2));
    act(() => result.current.clear());

    act(() => vi.advanceTimersByTime(OVERVIEW_PREVIEW_DELAY_MS));
    expect(result.current.preview).toBeNull();
  });

  it("restarts the dwell time when the pointer moves to another card", () => {
    const first = makeCard("first");
    const second = makeCard("second");
    const { result } = renderHook(() => useOverviewPreview());
    act(() => result.current.hover("first", first));
    act(() => vi.advanceTimersByTime(OVERVIEW_PREVIEW_DELAY_MS - 100));
    act(() => result.current.hover("second", second));

    act(() => vi.advanceTimersByTime(OVERVIEW_PREVIEW_DELAY_MS - 1));
    expect(result.current.preview).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.preview?.id).toBe("second");
  });

  it("drops the enlargement when the hovered card left the DOM", () => {
    const card = makeCard("first");
    const { result } = renderHook(() => useOverviewPreview());
    act(() => result.current.hover("first", card));
    card.remove();

    act(() => vi.advanceTimersByTime(OVERVIEW_PREVIEW_DELAY_MS));
    expect(result.current.preview).toBeNull();
  });

  it("clears a visible enlargement on window resize", () => {
    const card = makeCard("first");
    const { result } = renderHook(() => useOverviewPreview());
    act(() => result.current.hover("first", card));
    act(() => vi.advanceTimersByTime(OVERVIEW_PREVIEW_DELAY_MS));
    expect(result.current.preview?.id).toBe("first");

    act(() => window.dispatchEvent(new Event("resize")));
    expect(result.current.preview).toBeNull();
  });

  it("cancels a pending timer when the owning surface unmounts", () => {
    const card = makeCard("first");
    const { result, unmount } = renderHook(() => useOverviewPreview());
    act(() => result.current.hover("first", card));
    unmount();

    // Advancing past the dwell must not enqueue a state update after unmount.
    expect(() => act(() => vi.advanceTimersByTime(OVERVIEW_PREVIEW_DELAY_MS))).not.toThrow();
  });
});
