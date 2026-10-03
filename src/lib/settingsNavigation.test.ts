import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearPendingSettingsSection,
  consumePendingSettingsSection,
  openSettingsSection,
  OPEN_SETTINGS_SECTION_EVENT,
} from "./settingsNavigation";

afterEach(() => {
  clearPendingSettingsSection();
});

describe("settingsNavigation", () => {
  it("stores pending navigation with optional preset id", () => {
    openSettingsSection("language-servers", { presetId: "csharp" });
    expect(consumePendingSettingsSection()).toEqual({
      id: "language-servers",
      presetId: "csharp",
    });
  });

  it("dispatches the open-settings-section event", () => {
    const handler = vi.fn();
    window.addEventListener(OPEN_SETTINGS_SECTION_EVENT, handler);
    openSettingsSection("language-servers", { presetId: "rust" });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].detail).toEqual({
      id: "language-servers",
      presetId: "rust",
    });
    window.removeEventListener(OPEN_SETTINGS_SECTION_EVENT, handler);
  });

  it("clears pending navigation after consumption", () => {
    openSettingsSection("language-servers");
    clearPendingSettingsSection();
    expect(consumePendingSettingsSection()).toBeNull();
  });
});