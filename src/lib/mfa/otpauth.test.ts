import { describe, expect, it } from "vitest";
import { decodeBase32, encodeBase32, secretProblem } from "./base32";
import { encodeLumaFrames, parseLumaFrames } from "./frames";
import { formatCode, invalidInputField, mfaErrorCode, remainingSeconds } from "./format";
import { MfaImportError, accountLabel, isOtpauthLink, parseImportText, parseImportTexts, parseOtpauthUri } from "./otpauth";
import { decodeLumaFrames, decodeRgbaImage } from "./qrImage";
import { migrationLink, qrLumaFrame, qrRgba } from "./testing";

const RFC_SECRET = [...new TextEncoder().encode("12345678901234567890")];

describe("base32", () => {
  it("round-trips and normalises grouped secrets", () => {
    expect(encodeBase32(Uint8Array.from(RFC_SECRET))).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect([...decodeBase32("gezd gnbv-gy3t qojq gezd gnbv gy3t qojq==")]).toEqual(RFC_SECRET);
    expect(secretProblem("")).toBe("empty");
    expect(secretProblem("not base32!")).toBe("invalid");
    expect(secretProblem("JBSWY3DP")).toBe("short");
    expect(secretProblem("JBSWY3DPEHPK3PXP")).toBeNull();
  });
});

describe("otpauth links", () => {
  it("parses issuer, label prefix and parameters", () => {
    const input = parseOtpauthUri(
      "otpauth://totp/ACME%20Co:john.doe%40email.com?secret=HXDMVJECJJWSRB3HWIZR4IFUGFTMXBOZ&issuer=ACME%20Co&algorithm=SHA256&digits=8&period=60",
    );
    expect(input).toMatchObject({
      issuer: "ACME Co",
      accountName: "john.doe@email.com",
      secret: "HXDMVJECJJWSRB3HWIZR4IFUGFTMXBOZ",
      kind: "totp",
      algorithm: "SHA256",
      digits: 8,
      period: 60,
      counter: 0,
    });
    expect(accountLabel(input)).toBe("ACME Co · john.doe@email.com");
  });

  it("uses the label prefix when the issuer parameter is absent and reads HOTP counters", () => {
    const input = parseOtpauthUri("otpauth://hotp/QA%20Bank:alice?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&counter=7");
    expect(input).toMatchObject({ issuer: "QA Bank", accountName: "alice", kind: "hotp", counter: 7, digits: 6, algorithm: "SHA1" });
  });

  it("rejects non-OTP text and malformed links with distinct reasons", () => {
    expect(() => parseOtpauthUri("https://example.com")).toThrow(MfaImportError);
    try {
      parseImportText("https://example.com/not-an-otp");
    } catch (err) {
      expect((err as MfaImportError).reason).toBe("not-otp");
    }
    expect(() => parseOtpauthUri("otpauth://totp/x?issuer=y")).toThrow(/no secret/);
    expect(() => parseOtpauthUri("otpauth://steam/x?secret=JBSWY3DPEHPK3PXP")).toThrow(/unsupported OTP type/);
    expect(() => parseOtpauthUri("otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&algorithm=MD5")).toThrow(/algorithm/);
    expect(isOtpauthLink(" otpauth://totp/x?secret=A ")).toBe(true);
    expect(isOtpauthLink("hello")).toBe(false);
  });

  it("decodes Google Authenticator migration exports", () => {
    const link = migrationLink([
      { secret: RFC_SECRET, name: "qa.migrate@example.com", issuer: "QA Migrate HOTP", algorithm: 1, digits: 1, type: 1, counter: 3 },
      { secret: RFC_SECRET, name: "Beta Git:dev", issuer: "", algorithm: 2, digits: 2, type: 2 },
      { secret: RFC_SECRET, name: "legacy", issuer: "Old", algorithm: 4, digits: 1, type: 2 },
    ]);
    const items = parseImportText(link);
    expect(items).toHaveLength(3);
    expect(items[0].input).toMatchObject({ issuer: "QA Migrate HOTP", accountName: "qa.migrate@example.com", kind: "hotp", counter: 3, digits: 6, secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" });
    expect(items[1].input).toMatchObject({ issuer: "Beta Git", accountName: "dev", kind: "totp", algorithm: "SHA256", digits: 8 });
    expect(items[2]).toMatchObject({ input: null, error: expect.stringContaining("MD5"), label: "Old · legacy" });
  });

  it("collects non-OTP QR texts separately from importable ones", () => {
    const { items, rejected } = parseImportTexts(["https://example.com", "otpauth://totp/A:b?secret=JBSWY3DPEHPK3PXP"]);
    expect(items).toHaveLength(1);
    expect(rejected).toEqual(["https://example.com"]);
  });
});

describe("QR decoding", () => {
  const hotpLink = "otpauth://hotp/QA%20Bank:qa.hotp%40example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=QA%20Bank&counter=0";

  it("decodes desktop luma frames, including several codes and empty frames", async () => {
    const blank = { width: 64, height: 64, data: new Uint8Array(64 * 64).fill(255) };
    const texts = await decodeLumaFrames([qrLumaFrame(hotpLink), blank, qrLumaFrame("https://example.com/not-an-otp")]);
    expect(texts).toEqual(expect.arrayContaining([hotpLink, "https://example.com/not-an-otp"]));
    expect(texts).toHaveLength(2);
    expect(parseImportTexts(texts).items[0].input).toMatchObject({ issuer: "QA Bank", kind: "hotp" });
  });

  it("finds a QR inside a larger RGBA screenshot", async () => {
    const shot = qrRgba(hotpLink, { width: 900, height: 600, x: 420, y: 160 });
    await expect(decodeRgbaImage(shot)).resolves.toEqual([hotpLink]);
    await expect(decodeRgbaImage({ width: 32, height: 32, data: new Uint8ClampedArray(32 * 32 * 4).fill(255) })).resolves.toEqual([]);
  });

  it("decodes a migration QR end to end", async () => {
    const link = migrationLink([{ secret: RFC_SECRET, name: "a", issuer: "Mig", algorithm: 1, digits: 1, type: 2 }]);
    const [text] = await decodeLumaFrames([qrLumaFrame(link, 3)]);
    expect(parseImportText(text)[0].input).toMatchObject({ issuer: "Mig", accountName: "a", kind: "totp" });
  });
});

describe("frames and formatting", () => {
  it("round-trips the TQF1 luma container and rejects truncation", () => {
    const encoded = encodeLumaFrames([{ width: 2, height: 1, data: Uint8Array.from([0, 255]) }]);
    expect(parseLumaFrames(encoded.buffer as ArrayBuffer)).toEqual([{ width: 2, height: 1, data: Uint8Array.from([0, 255]) }]);
    expect(() => parseLumaFrames(encoded.subarray(0, encoded.length - 1))).toThrow(/truncated/);
    expect(() => parseLumaFrames(new Uint8Array(8))).toThrow(/unexpected/);
  });

  it("formats codes and maps backend errors", () => {
    expect(formatCode("755224")).toBe("755 224");
    expect(formatCode("1234567")).toBe("123 4567");
    expect(formatCode("94287082")).toBe("9428 7082");
    expect(remainingSeconds(30_000, 12_001)).toBe(18);
    expect(remainingSeconds(null, 0)).toBe(0);
    expect(mfaErrorCode(new Error("VAULT_LOCKED"))).toBe("VAULT_LOCKED");
    expect(mfaErrorCode("MFA_INVALID_INPUT: secret: bad")).toBe("MFA_INVALID_INPUT");
    expect(invalidInputField("MFA_INVALID_INPUT: secret: invalid Base32 character '!'")).toEqual({ field: "secret", detail: "invalid Base32 character '!'" });
    expect(mfaErrorCode("boom")).toBeNull();
  });
});
