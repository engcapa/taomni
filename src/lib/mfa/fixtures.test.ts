// Guards the QA QR fixtures (qa-ui-auto-tests/synthetic-fixtures/mfa) against
// drift: each PNG must decode with the app's decoder into the accounts its
// manifest promises, and the expected HOTP codes must match the stub generator.
// @ts-expect-error node builtin without DOM+node merged globals
import { readFileSync } from "node:fs";
// @ts-expect-error node builtin without DOM+node merged globals
import { join } from "node:path";
// @ts-expect-error node builtin without DOM+node merged globals
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { stubHotp } from "../../stubs/mfaStub";
import { decodeBase32 } from "./base32";
import { parseImportTexts } from "./otpauth";
import { decodeLumaFrames } from "./qrImage";

const cwd = (globalThis as { process?: { cwd(): string } }).process?.cwd() ?? ".";
const DIR: string = join(cwd, "qa-ui-auto-tests/synthetic-fixtures/mfa");

interface ManifestAccount {
  issuer: string;
  account: string;
  kind: "totp" | "hotp";
  secret: string;
  codes?: string[];
}
interface ManifestFixture {
  file: string;
  text: string | null;
  accounts: ManifestAccount[];
}

/** Minimal reader for the generator's 8-bit grayscale, filter-0 PNGs. */
function readGrayPng(file: string) {
  const bytes = new Uint8Array(readFileSync(join(DIR, file)));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];
  while (offset < bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      expect([data[8], data[9]]).toEqual([8, 0]);
    } else if (type === "IDAT") idat.push(data);
    offset += 12 + length;
  }
  const joined = new Uint8Array(idat.reduce((sum, part) => sum + part.length, 0));
  idat.reduce((at, part) => (joined.set(part, at), at + part.length), 0);
  const raw = new Uint8Array(inflateSync(joined));
  const luma = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    expect(raw[y * (width + 1)]).toBe(0);
    luma.set(raw.subarray(y * (width + 1) + 1, (y + 1) * (width + 1)), y * width);
  }
  return { width, height, data: luma };
}

const manifest = JSON.parse(String(readFileSync(join(DIR, "manifest.json"), "utf8"))) as { fixtures: ManifestFixture[] };

describe("MFA QA fixtures", () => {
  it.each(manifest.fixtures)("$file decodes to its manifest payload", async (fixture) => {
    const texts = await decodeLumaFrames([readGrayPng(fixture.file)]);
    expect(texts).toEqual(fixture.text === null ? [] : [fixture.text]);
    if (fixture.text === null) return;
    const { items } = parseImportTexts(texts);
    expect(items.map((item) => [item.input?.issuer, item.input?.accountName, item.input?.kind])).toEqual(
      fixture.accounts.map((account) => [account.issuer, account.account, account.kind]),
    );
    for (const account of fixture.accounts.filter((entry) => entry.codes)) {
      const secret = decodeBase32(account.secret);
      const codes = await Promise.all([0, 1, 2].map((counter) => stubHotp(secret, counter, 6, "SHA1")));
      expect(codes).toEqual(account.codes);
    }
  });
});
