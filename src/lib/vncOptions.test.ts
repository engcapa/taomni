import { describe, expect, it } from "vitest";
import {
  DEFAULT_VNC_VIEWER_OPTIONS,
  deserializeVncViewerOptions,
  parseVncViewerOptions,
  pictureQualityWire,
  serializeVncViewerOptions,
  writeVncViewerOptions,
} from "./vncOptions";

describe("VNC viewer options (VNC-CONN-001)", () => {
  it("reads sessions saved by older builds as RealVNC defaults", () => {
    expect(parseVncViewerOptions({ vncViewOnly: true, vncClipboardPolicy: "disabled" })).toEqual(DEFAULT_VNC_VIEWER_OPTIONS);
    expect(parseVncViewerOptions(null)).toEqual(DEFAULT_VNC_VIEWER_OPTIONS);
    expect(DEFAULT_VNC_VIEWER_OPTIONS).toMatchObject({
      pictureQuality: "automatic",
      scaling: "auto",
      shared: true,
      passSpecialKeys: true,
      menuKey: "F8",
      sendInitialClipboard: false,
      warnUnencrypted: true,
      autoReconnect: true,
    });
  });

  it("round-trips through session options without touching other keys", () => {
    const viewer = {
      ...DEFAULT_VNC_VIEWER_OPTIONS,
      pictureQuality: "low" as const,
      scaling: 150,
      menuKey: "F9" as const,
      warnUnencrypted: false,
    };
    const stored = writeVncViewerOptions({ vncViewOnly: true, passwordRef: "vault:1" }, viewer);
    expect(stored.vncViewOnly).toBe(true);
    expect(stored.passwordRef).toBe("vault:1");
    expect(parseVncViewerOptions(stored)).toEqual(viewer);
    expect(deserializeVncViewerOptions(serializeVncViewerOptions(viewer))).toEqual(viewer);
  });

  it("falls back per field for unknown or malformed values", () => {
    const parsed = parseVncViewerOptions({
      vncPictureQuality: "ultra",
      vncMenuKey: "F1",
      vncShared: "yes",
      vncScaling: 5000,
    });
    expect(parsed.pictureQuality).toBe("automatic");
    expect(parsed.menuKey).toBe("F8");
    expect(parsed.shared).toBe(true);
    expect(parsed.scaling).toBe("auto");
    expect(deserializeVncViewerOptions("{not json")).toEqual(DEFAULT_VNC_VIEWER_OPTIONS);
  });

  it("maps picture quality to the relay control byte", () => {
    expect(["automatic", "high", "medium", "low"].map((q) => pictureQualityWire(q as never))).toEqual([0, 1, 2, 3]);
  });
});
