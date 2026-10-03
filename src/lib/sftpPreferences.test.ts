import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SFTP_PREFERENCES,
  loadSftpPreferences,
  normalizeSftpPreferences,
  saveSftpPreferences,
  SFTP_PREFERENCES_EVENT,
  SFTP_PREFERENCES_STORAGE_KEY,
  subscribeSftpPreferences,
} from "./sftpPreferences";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("sftpPreferences", () => {
  it("defaults local double-click to open", () => {
    expect(DEFAULT_SFTP_PREFERENCES.localDoubleClickAction).toBe("open");
    expect(normalizeSftpPreferences(undefined).localDoubleClickAction).toBe("open");
    expect(loadSftpPreferences().localDoubleClickAction).toBe("open");
  });

  it("normalizes valid and invalid stored values", () => {
    expect(normalizeSftpPreferences({ localDoubleClickAction: "upload" }))
      .toEqual({ localDoubleClickAction: "upload" });
    expect(normalizeSftpPreferences({ localDoubleClickAction: "open" }))
      .toEqual({ localDoubleClickAction: "open" });
    expect(normalizeSftpPreferences({ localDoubleClickAction: "delete" }))
      .toEqual(DEFAULT_SFTP_PREFERENCES);
    expect(normalizeSftpPreferences({ localDoubleClickAction: 1 }))
      .toEqual(DEFAULT_SFTP_PREFERENCES);
    expect(normalizeSftpPreferences(null)).toEqual(DEFAULT_SFTP_PREFERENCES);
  });

  it("persists and reloads preferences", () => {
    saveSftpPreferences({ localDoubleClickAction: "upload" });
    expect(JSON.parse(localStorage.getItem(SFTP_PREFERENCES_STORAGE_KEY) ?? "{}"))
      .toEqual({ localDoubleClickAction: "upload" });
    expect(loadSftpPreferences()).toEqual({ localDoubleClickAction: "upload" });
  });

  it("notifies subscribers on save and storage events", () => {
    const listener = vi.fn();
    const unsub = subscribeSftpPreferences(listener);

    saveSftpPreferences({ localDoubleClickAction: "upload" });
    expect(listener).toHaveBeenCalledWith({ localDoubleClickAction: "upload" });

    // storage handler re-reads localStorage (other-tab write path).
    localStorage.setItem(
      SFTP_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ localDoubleClickAction: "open" }),
    );
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: SFTP_PREFERENCES_STORAGE_KEY,
        newValue: JSON.stringify({ localDoubleClickAction: "open" }),
      }),
    );
    expect(listener).toHaveBeenLastCalledWith({ localDoubleClickAction: "open" });

    // Unrelated storage keys are ignored.
    window.dispatchEvent(
      new StorageEvent("storage", { key: "other", newValue: "x" }),
    );
    expect(listener).toHaveBeenCalledTimes(2);

    unsub();
    window.dispatchEvent(
      new CustomEvent(SFTP_PREFERENCES_EVENT, {
        detail: { localDoubleClickAction: "upload" },
      }),
    );
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
