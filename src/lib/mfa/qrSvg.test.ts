import { describe, expect, it } from "vitest";
import { buildOtpauthUri, parseImportText } from "./otpauth";
import { decodeLumaFrames } from "./qrImage";
import { modulesToPath, qrSvgModel } from "./qrSvg";
import { defaultMfaInput, type MfaAccountInput } from "./types";

/** Rasterise the SVG path back to luma, 4 px per module, the way a camera would see it. */
function rasterise(size: number, path: string, scale = 4) {
  const width = size * scale;
  const data = new Uint8Array(width * width).fill(255);
  for (const match of path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\3z/g)) {
    const [x, y, run] = [Number(match[1]), Number(match[2]), Number(match[3])];
    for (let dy = 0; dy < scale; dy += 1) {
      const offset = (y * scale + dy) * width + x * scale;
      data.fill(0, offset, offset + run * scale);
    }
  }
  return { width, height: width, data };
}

describe("MFA export QR", () => {
  it("merges dark modules into one rectangle per horizontal run", () => {
    expect(modulesToPath([[true, true, false, true], [false, false, false, false], [false, true, true, true]])).toBe(
      "M0 0h2v1h-2zM3 0h1v1h-1zM1 2h3v1h-3z",
    );
  });

  it.each<Partial<MfaAccountInput>>([
    { kind: "hotp", issuer: "QA Bank & Co", accountName: "qa.hotp@example.com", secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", counter: 7 },
    { kind: "totp", issuer: "QA (TOTP)", accountName: "ops+mfa@example.com", secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA512", digits: 8, period: 60 },
    { kind: "totp", issuer: "", accountName: "solo@example.com", secret: "JBSWY3DPEHPK3PXP" },
  ])("round-trips $kind $issuer through a scannable QR code", async (fields) => {
    const account = { ...defaultMfaInput(), ...fields } as MfaAccountInput;
    const uri = buildOtpauthUri(account);
    const model = await qrSvgModel(uri);
    expect(await decodeLumaFrames([rasterise(model.size, model.path)])).toEqual([uri]);
    const [item] = parseImportText(uri);
    expect(item.input).toMatchObject({
      kind: account.kind,
      issuer: account.issuer,
      accountName: account.accountName,
      secret: account.secret,
      algorithm: account.algorithm,
      digits: account.digits,
      ...(account.kind === "totp" ? { period: account.period } : { counter: account.counter }),
    });
  });

  it("matches the backend's otpauth encoding", () => {
    expect(
      buildOtpauthUri({ ...defaultMfaInput(), kind: "hotp", issuer: "QA Bank & Co", accountName: "qa.hotp@example.com", secret: "gezd gnbv gy3t qojq gezd gnbv gy3t qojq", counter: 1 }),
    ).toBe(
      "otpauth://hotp/QA%20Bank%20%26%20Co:qa.hotp%40example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=QA%20Bank%20%26%20Co&algorithm=SHA1&digits=6&counter=1",
    );
  });
});
