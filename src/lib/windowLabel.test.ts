import { afterEach, describe, expect, it } from "vitest";
import { addressesThisWindow, currentWindowLabel } from "./windowLabel";

type TauriGlobal = { __TAURI_INTERNALS__?: unknown };

function setWindowLabel(label: string | null): void {
  const target = window as unknown as TauriGlobal;
  if (label === null) {
    delete target.__TAURI_INTERNALS__;
    return;
  }
  target.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label } } };
}

afterEach(() => {
  setWindowLabel(null);
});

describe("currentWindowLabel", () => {
  it("returns the label of the webview it runs in", () => {
    setWindowLabel("terminal-abc");
    expect(currentWindowLabel()).toBe("terminal-abc");
  });

  it("returns null when the runtime exposes no label", () => {
    setWindowLabel(null);
    expect(currentWindowLabel()).toBeNull();
  });

  it("returns null for an empty label instead of an empty-string window", () => {
    setWindowLabel("");
    expect(currentWindowLabel()).toBeNull();
  });
});

describe("addressesThisWindow", () => {
  it("accepts an unlabelled broadcast in every window", () => {
    setWindowLabel("main");
    expect(addressesThisWindow(undefined)).toBe(true);
    expect(addressesThisWindow(null)).toBe(true);
    expect(addressesThisWindow("")).toBe(true);
  });

  it("accepts an event addressed to this window", () => {
    setWindowLabel("terminal-abc");
    expect(addressesThisWindow("terminal-abc")).toBe(true);
  });

  it("rejects an event addressed to another window", () => {
    setWindowLabel("main");
    expect(addressesThisWindow("terminal-abc")).toBe(false);
  });

  it("accepts a labelled event when this window cannot report a label", () => {
    // Dropping the prompt would hide an approval nobody can answer, so an
    // unknown local label must not filter events out.
    setWindowLabel(null);
    expect(addressesThisWindow("terminal-abc")).toBe(true);
  });
});
