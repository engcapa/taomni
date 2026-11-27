import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { setAppThemeMode } from "../lib/appTheme";
import { UI_FONT_FAMILY_KEY, UI_FONT_SIZE_KEY } from "../stores/app/preferences";
import { useWindowAppearance } from "./useWindowAppearance";

afterEach(() => {
  cleanup();
  localStorage.clear();
  setAppThemeMode("system");
  vi.unstubAllGlobals();
});

it("loads standalone fonts, follows resets from another window and unsubscribes when closed", () => {
  const style = document.documentElement.style;
  localStorage.setItem(UI_FONT_FAMILY_KEY, "Georgia");
  localStorage.setItem(UI_FONT_SIZE_KEY, "18");
  const { unmount } = renderHook(() => useWindowAppearance());
  expect(style.getPropertyValue("--taomni-ui-font-family")).toBe("Georgia");
  expect(style.getPropertyValue("--taomni-ui-font-size")).toBe("18px");
  localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: null }));
  expect(style.getPropertyValue("--taomni-ui-font-family")).toBe("Inter");
  expect(style.getPropertyValue("--taomni-ui-font-size")).toBe("12px");
  unmount();
  localStorage.setItem(UI_FONT_SIZE_KEY, "10");
  window.dispatchEvent(new StorageEvent("storage", { key: UI_FONT_SIZE_KEY }));
  expect(style.getPropertyValue("--taomni-ui-font-size")).toBe("12px");
});

it("applies explicit themes and resumes live system updates when following the OS", () => {
  const media = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal("matchMedia", () => media);
  const { rerender } = renderHook(({ size }) => useWindowAppearance("Georgia", size), {
    initialProps: { size: 10 },
  });
  const root = document.documentElement;
  expect(root.dataset.appTheme).toBe("light");
  act(() => setAppThemeMode("light"));
  act(() => { media.matches = true; media.dispatchEvent(new Event("change")); });
  expect(root.dataset.appTheme).toBe("light");
  act(() => setAppThemeMode("system"));
  expect(root.dataset.appTheme).toBe("dark");
  act(() => { media.matches = false; media.dispatchEvent(new Event("change")); });
  expect(root.dataset.appTheme).toBe("light");
  rerender({ size: 18 });
  expect(root.style.getPropertyValue("--taomni-ui-font-size")).toBe("18px");
});
