import { describe, expect, it } from "vitest";

import {
  applyExtended,
  encodeAck,
  encodeKey,
  encodePing,
  encodePointer,
  encodeResize,
  IN_ACK,
  IN_KEY,
  IN_PING,
  IN_POINTER,
  IN_RESIZE,
  keyEventToScancode,
  mouseButtonMask,
  OUT_FRAME,
  parseFrameTile,
  parseRdpWsText,
} from "./rdp";
import {
  DEFAULT_RDP_OPTIONS,
  parseRdpOptions,
  serializeRdpOptions,
  type RdpOptions,
} from "../types/rdp";

describe("rdp WS encoders", () => {
  it("encodes ping/ack as single tag bytes", () => {
    expect(new Uint8Array(encodePing())).toEqual(new Uint8Array([IN_PING]));
    expect(new Uint8Array(encodeAck())).toEqual(new Uint8Array([IN_ACK]));
  });

  it("encodes a key event as [tag, down, scan_be]", () => {
    const buf = new Uint8Array(encodeKey(true, 0x1c)); // Enter
    expect(buf[0]).toBe(IN_KEY);
    expect(buf[1]).toBe(1);
    expect(buf[2]).toBe(0x00);
    expect(buf[3]).toBe(0x1c);
  });

  it("encodes a pointer event with big-endian coordinates", () => {
    const buf = new Uint8Array(encodePointer(0x0190, 0x012c, 0x05));
    expect(buf[0]).toBe(IN_POINTER);
    expect(buf[1]).toBe(0x05);
    expect(buf[2]).toBe(0x01);
    expect(buf[3]).toBe(0x90);
    expect(buf[4]).toBe(0x01);
    expect(buf[5]).toBe(0x2c);
  });

  it("encodes a resize event", () => {
    const buf = new Uint8Array(encodeResize(1920, 1080));
    expect(buf[0]).toBe(IN_RESIZE);
    expect(buf[1]).toBe(0x07);
    expect(buf[2]).toBe(0x80);
    expect(buf[3]).toBe(0x04);
    expect(buf[4]).toBe(0x38);
  });

  it("applyExtended sets bit 0x100 when extended", () => {
    expect(applyExtended(0x1d, false)).toBe(0x1d);
    expect(applyExtended(0x1d, true)).toBe(0x11d);
  });
});

describe("rdp WS frame parser", () => {
  it("parses a tile with the expected geometry", () => {
    const w = 4;
    const h = 2;
    const rgba = new Uint8Array([
      // 4×2 pixels, 32 bytes
      ...new Array(32).fill(0).map((_, i) => i % 256),
    ]);
    const buf = new Uint8Array(9 + rgba.length);
    buf[0] = OUT_FRAME;
    new DataView(buf.buffer).setUint16(1, 10);
    new DataView(buf.buffer).setUint16(3, 20);
    new DataView(buf.buffer).setUint16(5, w);
    new DataView(buf.buffer).setUint16(7, h);
    buf.set(rgba, 9);
    const tile = parseFrameTile(buf.buffer);
    expect(tile).not.toBeNull();
    expect(tile?.x).toBe(10);
    expect(tile?.y).toBe(20);
    expect(tile?.w).toBe(w);
    expect(tile?.h).toBe(h);
    expect(tile?.rgba.length).toBe(rgba.length);
  });

  it("returns null for non-FRAME frames", () => {
    const buf = new Uint8Array([99, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseFrameTile(buf.buffer)).toBeNull();
  });

  it("returns null when frame is too short", () => {
    const buf = new Uint8Array([OUT_FRAME, 0, 0]);
    expect(parseFrameTile(buf.buffer)).toBeNull();
  });
});

describe("rdp WS text parser", () => {
  it("parses a connected event", () => {
    const msg = parseRdpWsText(
      JSON.stringify({
        type: "connected",
        width: 1920,
        height: 1080,
        protocol: "TLS",
        server_name: "host",
      }),
    );
    expect(msg?.type).toBe("connected");
    if (msg?.type === "connected") {
      expect(msg.width).toBe(1920);
      expect(msg.protocol).toBe("TLS");
    }
  });

  it("returns null for invalid JSON", () => {
    expect(parseRdpWsText("not json")).toBeNull();
  });
});

describe("keyEventToScancode", () => {
  it("maps known key codes", () => {
    expect(keyEventToScancode({ code: "Enter" } as KeyboardEvent)).toEqual({
      scancode: 0x1c,
      extended: false,
    });
    expect(keyEventToScancode({ code: "ArrowUp" } as KeyboardEvent)).toEqual({
      scancode: 0x48,
      extended: true,
    });
    expect(keyEventToScancode({ code: "KeyA" } as KeyboardEvent)).toEqual({
      scancode: 0x1e,
      extended: false,
    });
  });

  it("returns null for unmapped codes", () => {
    expect(keyEventToScancode({ code: "AbsentKey" } as KeyboardEvent)).toBeNull();
  });
});

describe("mouseButtonMask", () => {
  it("translates DOM button bits to RDP mask", () => {
    expect(mouseButtonMask({ buttons: 1 } as MouseEvent)).toBe(0x01);
    expect(mouseButtonMask({ buttons: 2 } as MouseEvent)).toBe(0x02);
    expect(mouseButtonMask({ buttons: 4 } as MouseEvent)).toBe(0x04);
    expect(mouseButtonMask({ buttons: 7 } as MouseEvent)).toBe(0x07);
    expect(mouseButtonMask({ buttons: 0 } as MouseEvent)).toBe(0x00);
  });
});

describe("RdpOptions parse/serialize", () => {
  it("returns defaults for empty / invalid input", () => {
    expect(parseRdpOptions(undefined)).toEqual(DEFAULT_RDP_OPTIONS);
    expect(parseRdpOptions("")).toEqual(DEFAULT_RDP_OPTIONS);
    expect(parseRdpOptions("{not: json}")).toEqual(DEFAULT_RDP_OPTIONS);
    expect(parseRdpOptions("[1,2,3]")).toEqual(DEFAULT_RDP_OPTIONS);
  });

  it("round-trips a configuration with gateway", () => {
    const opts: RdpOptions = {
      ...DEFAULT_RDP_OPTIONS,
      domain: "CORP",
      colorDepth: 16,
      screenW: 1366,
      screenH: 768,
      nla: false,
      redirectClipboard: false,
      redirectAudio: "off",
      redirectDrive: { enabled: true, label: "SHARED", path: "/data" },
      gateway: {
        host: "rdg.example.com",
        port: 443,
        username: "alice@CORP",
        password: "vault:abc",
        auth: "ntlm",
        useSessionCreds: true,
      },
    };
    const json = serializeRdpOptions(opts);
    const back = parseRdpOptions(json);
    expect(back).toEqual(opts);
  });

  it("clamps invalid color depth and screen sizes back to defaults", () => {
    const json = JSON.stringify({
      colorDepth: 7, // not in the allow-list
      screenW: 100, // below min
      screenH: 99999,
    });
    const o = parseRdpOptions(json);
    expect(o.colorDepth).toBe(32);
    expect(o.screenW).toBe(1920);
    expect(o.screenH).toBe(1080);
  });

  it("drops gateway when host is missing", () => {
    const json = JSON.stringify({ gateway: { port: 443 } });
    expect(parseRdpOptions(json).gateway).toBeUndefined();
  });

  it("truncates drive label longer than 8 chars", () => {
    const json = JSON.stringify({
      redirectDrive: { enabled: true, label: "VERYLONGLABEL", path: "/x" },
    });
    expect(parseRdpOptions(json).redirectDrive.label).toBe("VERYLONG");
  });
});
