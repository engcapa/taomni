// Regenerates the MFA QR fixtures used by TC-MFA-* (see
// docs-feature/mfa-authenticator-design.md, TASK-08). Run from the repository
// root: `node qa-ui-auto-tests/synthetic-fixtures/mfa/generate.mjs`.
// Every payload and expected code is written to manifest.json; the PNGs are
// deterministic for a given `qr` version.

import { createHmac } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import encodeQR from "qr";

const OUT = dirname(fileURLToPath(import.meta.url));
const ascii = (text) => [...Buffer.from(text, "ascii")];

function base32(bytes) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

function hotp(secret, counter, digits = 6) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", Buffer.from(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits).padStart(digits, "0");
}

// --- Google Authenticator migration payload (protobuf) ---------------------
function varint(value) {
  const out = [];
  let v = value;
  do {
    let byte = v % 128;
    v = Math.floor(v / 128);
    if (v > 0) byte |= 0x80;
    out.push(byte);
  } while (v > 0);
  return out;
}
const lenField = (field, bytes) => [...varint(field * 8 + 2), ...varint(bytes.length), ...bytes];
const intField = (field, value) => [...varint(field * 8), ...varint(value)];

/** entries: { secret, name, issuer, type: 1 HOTP | 2 TOTP, counter? } (SHA1, six digits). */
function migrationLink(entries) {
  const payload = entries.flatMap((entry) =>
    lenField(1, [
      ...lenField(1, entry.secret),
      ...lenField(2, [...Buffer.from(entry.name, "utf8")]),
      ...lenField(3, [...Buffer.from(entry.issuer, "utf8")]),
      ...intField(4, 1),
      ...intField(5, 1),
      ...intField(6, entry.type),
      ...intField(7, entry.counter ?? 0),
    ]),
  );
  const bytes = [...payload, ...intField(2, 1), ...intField(3, 1), ...intField(4, 0), ...intField(5, 4242)];
  return `otpauth-migration://offline?data=${encodeURIComponent(Buffer.from(bytes).toString("base64"))}`;
}

// --- 8-bit grayscale PNG ----------------------------------------------------
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}
function png(width, height, pixel) {
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width + 1)] = 0;
    for (let x = 0; x < width; x += 1) raw[y * (width + 1) + 1 + x] = pixel(x, y);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // grayscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
function qrPng(text, scale = 8) {
  const modules = encodeQR(text, "raw", { border: 4 });
  const size = modules.length * scale;
  return png(size, size, (x, y) => (modules[Math.floor(y / scale)][Math.floor(x / scale)] ? 0 : 255));
}

// --- Fixtures ----------------------------------------------------------------
const RFC4226 = ascii("12345678901234567890");
const hotpAccount = (issuer, account, secret) => ({
  issuer,
  account,
  kind: "hotp",
  secret: base32(secret),
  codes: [0, 1, 2].map((counter) => hotp(secret, counter)),
});
const hotpUri = (a) =>
  `otpauth://hotp/${encodeURIComponent(a.issuer)}:${encodeURIComponent(a.account)}?secret=${a.secret}&issuer=${encodeURIComponent(a.issuer)}&counter=0`;

const bank = hotpAccount("QA Bank", "qa.hotp@example.com", RFC4226);
const paste = hotpAccount("QA Paste", "paste@example.com", ascii("qa-paste-secret-0001"));
const two = [
  { issuer: "QA Mail", account: "mail@example.com", kind: "totp", secret: ascii("qa-migration-mail-01") },
  { issuer: "QA Git", account: "dev@example.com", kind: "hotp", secret: ascii("qa-migration-git-001") },
];
const four = [
  // Account names sort differently from issuers so both sort modes are distinguishable.
  ["Zeta Cloud", "amy@example.com", "qa-sort-zeta-secret1"],
  ["Alpha Mail", "zoe@example.com", "qa-sort-alpha-secret"],
  ["Mid Bank", "kim@example.com", "qa-sort-mid-secret01"],
  ["Beta Git", "dan@example.com", "qa-sort-beta-secret1"],
].map(([issuer, account, secret]) => ({ issuer, account, kind: "hotp", secret: ascii(secret) }));
const migrationOf = (entries) =>
  migrationLink(entries.map((e) => ({ secret: e.secret, name: e.account, issuer: e.issuer, type: e.kind === "hotp" ? 1 : 2 })));
const describe = (e) => ({
  issuer: e.issuer,
  account: e.account,
  kind: e.kind,
  secret: base32(e.secret),
  ...(e.kind === "hotp" ? { codes: [0, 1, 2].map((counter) => hotp(e.secret, counter)) } : {}),
});

const fixtures = [
  { file: "hotp-qa-bank.png", text: hotpUri(bank), accounts: [bank] },
  { file: "hotp-qa-paste.png", text: hotpUri(paste), accounts: [paste] },
  { file: "not-otp.png", text: "https://example.com/qa-not-an-otp", accounts: [] },
  { file: "migration-two.png", text: migrationOf(two), accounts: two.map(describe) },
  { file: "migration-four.png", text: migrationOf(four), accounts: four.map(describe) },
];
const manifest = { generator: "generate.mjs", fixtures: [] };
for (const fixture of fixtures) {
  writeFileSync(join(OUT, fixture.file), qrPng(fixture.text));
  manifest.fixtures.push(fixture);
}
// No QR at all: stripes that a decoder must reject.
writeFileSync(join(OUT, "no-qr.png"), png(240, 160, (x, y) => (Math.floor((x + y) / 12) % 2 ? 40 : 230)));
manifest.fixtures.push({ file: "no-qr.png", text: null, accounts: [] });
writeFileSync(join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(manifest.fixtures.map((f) => `${f.file}: ${f.accounts.map((a) => `${a.issuer} ${a.codes?.join("/") ?? a.kind}`).join(", ")}`).join("\n"));
