import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import {
  VNC_WHEEL_DOWN,
  VNC_WHEEL_LEFT,
  VNC_WHEEL_RIGHT,
  VNC_WHEEL_UP,
  VncWheelAccumulator,
  codePointToKeysym,
  computeVncDisplaySize,
  mouseButtonMask,
  normalizeVncScaling,
  encodeWsKey,
  encodeWsPointer,
  encodeWsRefresh,
  iterCodePoints,
  keyEventToKeysym,
  mapClientToFramebuffer,
  parseFrameHeader,
  parseVncError,
  parseWsMessage,
  redactVncHandoff,
  vncConnect,
  vncConsumeDetachClaim,
  vncCreateDetachClaim,
  vncCursorToCss,
  vncTestConnection,
} from "./vnc";

function keyEvent(key: string, code = "", location = 0): KeyboardEvent {
  return new KeyboardEvent("keydown", { key, code, location });
}

describe("VNC WebSocket protocol", () => {
  beforeEach(() => mocks.invoke.mockReset());

  it("encodes binary controls in network byte order", () => {
    expect([...new Uint8Array(encodeWsKey(true, 0xff0d))]).toEqual([2, 1, 0, 0, 0xff, 0x0d]);
    expect([...new Uint8Array(encodeWsPointer(0x1234, 0xabcd, 5))]).toEqual([3, 5, 0x12, 0x34, 0xab, 0xcd]);
    expect([...new Uint8Array(encodeWsRefresh())]).toEqual([4]);
  });

  it("parses structured backend errors", () => {
    expect(parseVncError('{"code":"tcp-failed","stage":"tcp","retryable":true,"message":"timeout"}')).toEqual({
      code: "tcp-failed", stage: "tcp", retryable: true, message: "timeout",
    });
    expect(parseVncError(new Error("legacy"))).toMatchObject({ code: "vnc-error", message: "legacy" });
  });

  it("rejects malformed text messages", () => {
    expect(parseWsMessage("not-json")).toBeNull();
    expect(parseWsMessage('{"type":"connected","width":"1","height":1,"name":"x"}')).toBeNull();
    expect(parseWsMessage('{"type":"unknown"}')).toBeNull();
    expect(parseWsMessage('{"type":"disconnected","reason":"closed"}')).toBeNull();
    expect(parseWsMessage('{"type":"disconnected","code":"connection-lost","stage":"runtime","retryable":true,"reason":"closed"}')).toMatchObject({
      type: "disconnected", retryable: true, reason: "closed",
    });
    expect(parseWsMessage('{"type":"connected","width":1,"height":2,"name":"x","protocol":"3.8","security":"VNCAuth","encrypted":false}')).toEqual({
      type: "connected", width: 1, height: 2, name: "x", protocol: "3.8", security: "VNCAuth", encrypted: false,
    });
    expect(parseWsMessage('{"type":"connected","width":16385,"height":1,"name":"x","protocol":"3.8","security":"VNCAuth","encrypted":false}')).toBeNull();
    expect(parseWsMessage('{"type":"disconnected","code":"closed","stage":"invalid","retryable":false,"reason":"closed"}')).toBeNull();
    expect(parseWsMessage('{"type":"desktop_size","width":2560,"height":1440,"generation":1}')).toEqual({
      type: "desktop_size", width: 2560, height: 1440, generation: 1,
    });
    expect(parseWsMessage('{"type":"desktop_size","width":0,"height":1440,"generation":1}')).toBeNull();
    expect(parseWsMessage('{"type":"pointer_pos","x":123,"y":456}')).toEqual({
      type: "pointer_pos", x: 123, y: 456,
    });
    expect(parseWsMessage('{"type":"pointer_pos","x":65536,"y":0}')).toBeNull();
    expect(parseWsMessage('{"type":"pointer_pos","x":1.5,"y":0}')).toBeNull();
    const cursor = parseWsMessage('{"type":"cursor","visible":true,"hotspot_x":1,"hotspot_y":2,"width":16,"height":16,"png_base64":"iVBORw0KGgo="}');
    expect(cursor).toMatchObject({ type: "cursor", visible: true, hotspot_x: 1, hotspot_y: 2 });
    expect(cursor?.type === "cursor" ? vncCursorToCss(cursor) : "").toContain("data:image/png;base64,iVBORw0KGgo=");
    expect(parseWsMessage('{"type":"cursor","visible":true,"hotspot_x":16,"hotspot_y":0,"width":16,"height":16,"png_base64":"iVBORw0KGgo="}')).toBeNull();
    expect(parseWsMessage('{"type":"cursor","visible":false,"hotspot_x":0,"hotspot_y":0,"width":0,"height":0,"png_base64":""}')).toMatchObject({ type: "cursor", visible: false });
  });

  it("validates binary frame geometry and exact payload length", () => {
    const good = new ArrayBuffer(12 + 2 * 3 * 4);
    const view = new DataView(good);
    view.setUint16(4, 2);
    view.setUint16(6, 3);
    expect(parseFrameHeader(good)).toEqual({ x: 0, y: 0, w: 2, h: 3 });
    expect(parseFrameHeader(good.slice(0, -1))).toBeNull();
    view.setUint32(8, 1);
    expect(parseFrameHeader(good)).toBeNull();
  });

  it("removes credentials and network secrets from persisted detach handoffs", () => {
    const redacted = redactVncHandoff({
      host: "vnc.internal",
      port: 5900,
      username: "alice",
      password: "top-secret",
      networkSettingsJson: '{"proxyPass":"proxy-secret"}',
    }, "claim-1");
    expect(redacted).toMatchObject({ host: "", port: 0, username: null, claimId: "claim-1" });
    expect(JSON.stringify(redacted)).not.toContain("top-secret");
    expect(JSON.stringify(redacted)).not.toContain("proxy-secret");
  });

  it("forwards network and policy options through connect and connection testing", async () => {
    mocks.invoke
      .mockResolvedValueOnce({ session_id: "vnc-1", ws_port: 41000, ws_token: "token", width: 1, height: 1, name: "fixture" })
      .mockResolvedValueOnce("Connection successful");

    await vncConnect(
      "vnc.example.test",
      5901,
      " alice ",
      "password",
      '{"proxy_kind":"socks5"}',
      "require-encryption",
      true,
      "server-to-client",
    );
    await vncTestConnection(
      "vnc.example.test",
      5901,
      " alice ",
      "password",
      '{"proxy_kind":"socks5"}',
      "require-encryption",
    );

    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "vnc_connect", {
      host: "vnc.example.test",
      port: 5901,
      username: "alice",
      password: "password",
      networkSettingsJson: '{"proxy_kind":"socks5"}',
      securityPolicy: "require-encryption",
      viewOnly: true,
      clipboardPolicy: "server-to-client",
      // Older callers pass no viewer extras; the backend keeps its defaults.
      pictureQuality: null,
      shared: null,
      allowUnencrypted: null,
      attemptId: null,
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "vnc_test_connection", {
      host: "vnc.example.test",
      port: 5901,
      username: "alice",
      password: "password",
      networkSettingsJson: '{"proxy_kind":"socks5"}',
      securityPolicy: "require-encryption",
    });
  });

  it("creates and consumes one-time detach claims through backend memory", async () => {
    const claim = {
      host: "vnc.internal",
      port: 5900,
      username: "alice",
      password: "secret",
      network_settings_json: null,
      security_policy: "prefer-encryption" as const,
      view_only: false,
      clipboard_policy: "bidirectional" as const,
    };
    mocks.invoke.mockResolvedValueOnce({ claim_id: "claim-1" }).mockResolvedValueOnce(claim);

    await expect(vncCreateDetachClaim(claim)).resolves.toBe("claim-1");
    await expect(vncConsumeDetachClaim("claim-1")).resolves.toEqual(claim);

    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "vnc_create_detach_claim", { claim });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "vnc_consume_detach_claim", { claimId: "claim-1" });
  });
});

describe("VNC keysyms", () => {
  it("distinguishes right-side modifiers and keypad keys", () => {
    expect(keyEventToKeysym(keyEvent("Control", "ControlRight", KeyboardEvent.DOM_KEY_LOCATION_RIGHT))).toBe(0xffe4);
    expect(keyEventToKeysym(keyEvent("Enter", "NumpadEnter", KeyboardEvent.DOM_KEY_LOCATION_NUMPAD))).toBe(0xff8d);
    expect(keyEventToKeysym(keyEvent("1", "Numpad1", KeyboardEvent.DOM_KEY_LOCATION_NUMPAD))).toBe(0xffb1);
    expect(keyEventToKeysym(keyEvent("AltGraph", "AltRight", KeyboardEvent.DOM_KEY_LOCATION_RIGHT))).toBe(0xfe03);
    expect(keyEventToKeysym(keyEvent("F24", "F24"))).toBe(0xffd5);
  });

  it("maps Unicode code points and preserves surrogate pairs", () => {
    expect(codePointToKeysym(0x41)).toBe(0x41);
    expect(codePointToKeysym(0x4e2d)).toBe(0x01004e2d);
    expect(keyEventToKeysym(keyEvent("中", "KeyA"))).toBe(0x01004e2d);
    expect(keyEventToKeysym(keyEvent("😀", "KeyA"))).toBe(0x0101f600);
    expect(codePointToKeysym(0x110000)).toBe(0);
    expect([...iterCodePoints("A😀")]).toEqual([0x41, 0x1f600]);
  });
});

describe("VNC pointer coordinates", () => {
  it("maps 1:1 CSS coordinates without using device pixel ratio", () => {
    expect(mapClientToFramebuffer(
      1060,
      590,
      { left: 100, top: 50, width: 1920, height: 1080 },
      1920,
      1080,
      "one",
    )).toEqual({ x: 960, y: 540, inside: true });
  });

  it("accounts for horizontal and vertical fit-mode letterboxing", () => {
    expect(mapClientToFramebuffer(
      500,
      500,
      { left: 0, top: 0, width: 1000, height: 1000 },
      1600,
      900,
      "fit",
    )).toEqual({ x: 800, y: 450, inside: true });
    expect(mapClientToFramebuffer(
      500,
      500,
      { left: 0, top: 0, width: 1000, height: 1000 },
      900,
      1600,
      "fit",
    )).toEqual({ x: 450, y: 800, inside: true });
  });

  it("marks letterbox input outside while retaining clamped release coordinates", () => {
    expect(mapClientToFramebuffer(
      500,
      100,
      { left: 0, top: 0, width: 1000, height: 1000 },
      1600,
      900,
      "fit",
    )).toEqual({ x: 800, y: 0, inside: false });
    expect(mapClientToFramebuffer(
      -20,
      1200,
      { left: 0, top: 0, width: 1000, height: 1000 },
      1600,
      900,
      "fit",
    )).toEqual({ x: 0, y: 899, inside: false });
  });

  it("rejects invalid framebuffer or viewport geometry", () => {
    expect(mapClientToFramebuffer(
      0,
      0,
      { left: 0, top: 0, width: 0, height: 100 },
      1920,
      1080,
      "fit",
    )).toBeNull();
    expect(mapClientToFramebuffer(
      Number.NaN,
      0,
      { left: 0, top: 0, width: 100, height: 100 },
      1920,
      1080,
      "fit",
    )).toBeNull();
  });
});

describe("VNC viewer scaling (RealVNC Scaling options)", () => {
  it("auto shrinks to fit but never enlarges past one device pixel per remote pixel", () => {
    // 1680x1050 desktop, 1200x800 CSS viewport, DPR 1.25.
    const shrink = computeVncDisplaySize("auto", 1680, 1050, 1200, 800, 1.25);
    expect(shrink.width).toBeLessThanOrEqual(1200);
    expect(shrink.height).toBeLessThanOrEqual(800);
    expect(shrink.width / shrink.height).toBeCloseTo(1680 / 1050, 2);
    expect(shrink.scrolls).toBe(false);

    const small = computeVncDisplaySize("auto", 800, 600, 1600, 1000, 1.25);
    expect(small).toEqual({ width: 640, height: 480, scrolls: false });
  });

  it("maps 100% to device pixels and scrolls when larger than the viewport", () => {
    expect(computeVncDisplaySize(100, 1680, 1050, 1000, 700, 1.25)).toEqual({
      width: 1344,
      height: 840,
      scrolls: true,
    });
    expect(computeVncDisplaySize(50, 1680, 1050, 1000, 700, 1)).toEqual({
      width: 840,
      height: 525,
      scrolls: false,
    });
  });

  it("fits window, width and height in both directions and can stretch", () => {
    expect(computeVncDisplaySize("fit", 800, 600, 1600, 900, 1)).toEqual({ width: 1200, height: 900, scrolls: false });
    expect(computeVncDisplaySize("fit", 800, 600, 1600, 900, 1, false)).toEqual({ width: 1600, height: 900, scrolls: false });
    expect(computeVncDisplaySize("fit-width", 800, 600, 400, 200, 1)).toEqual({ width: 400, height: 300, scrolls: true });
    expect(computeVncDisplaySize("fit-height", 800, 600, 400, 300, 1)).toEqual({ width: 400, height: 300, scrolls: false });
  });

  it("normalizes persisted scaling values", () => {
    expect(normalizeVncScaling("fit-width")).toBe("fit-width");
    expect(normalizeVncScaling("150")).toBe(150);
    expect(normalizeVncScaling(5)).toBe("auto");
    expect(normalizeVncScaling("stretch")).toBe("auto");
  });
});

describe("VNC wheel and buttons", () => {
  it("turns one mouse notch into one wheel step and accumulates trackpad deltas", () => {
    const wheel = new VncWheelAccumulator();
    expect(wheel.push(0, 100, 0)).toEqual([VNC_WHEEL_DOWN]);
    expect(wheel.push(0, -100, 0)).toEqual([VNC_WHEEL_UP]);
    const trackpad = Array.from({ length: 9 }, () => wheel.push(0, 12, 0)).flat();
    expect(trackpad).toEqual([VNC_WHEEL_DOWN]);
    expect(wheel.push(-250, 0, 0)).toEqual([VNC_WHEEL_LEFT, VNC_WHEEL_LEFT]);
    // Line-mode deltas (Firefox): three lines are one detent.
    expect(new VncWheelAccumulator().push(3, 0, 1)).toEqual([VNC_WHEEL_RIGHT]);
  });

  it("caps a single event so a huge delta does not scroll for seconds", () => {
    const wheel = new VncWheelAccumulator();
    expect(wheel.push(0, 100_000, 0)).toHaveLength(10);
    expect(wheel.push(0, 0, 0)).toEqual([]);
  });

  it("maps the back button to RFB button 8", () => {
    const back = new MouseEvent("pointerdown", { buttons: 1 | 8 });
    expect(mouseButtonMask(back)).toBe(0x81);
    expect(mouseButtonMask(new MouseEvent("pointerdown", { buttons: 2 | 4 }))).toBe(4 | 2);
  });

  it("accepts relay stats and rejects malformed counters", () => {
    const stats = {
      type: "stats",
      requested_encoding: "ZRLE",
      last_encoding: "ZRLE",
      pixel_format: "depth 24 (32 bpp) little-endian rgb888",
      wire_kbps: 12000,
      line_kbps: null,
      updates_per_sec: 3.5,
      frames_per_sec: 3,
      update_ms: 12.5,
    };
    expect(parseWsMessage(JSON.stringify(stats))).toEqual(stats);
    expect(parseWsMessage(JSON.stringify({ ...stats, wire_kbps: -1 }))).toBeNull();
    expect(parseWsMessage(JSON.stringify({ ...stats, last_encoding: 7 }))).toBeNull();
  });
});
