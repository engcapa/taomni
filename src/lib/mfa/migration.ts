// Google Authenticator "Transfer accounts" export:
// otpauth-migration://offline?data=<base64 MigrationPayload protobuf>.
// Only the documented OtpParameters fields are read; unknown fields are skipped.

import { encodeBase32 } from "./base32";
import type { MfaAccountInput, MfaAlgorithm } from "./types";

export interface MigrationEntry {
  secret: Uint8Array;
  name: string;
  issuer: string;
  /** 0 unspecified, 1 SHA1, 2 SHA256, 3 SHA512, 4 MD5. */
  algorithm: number;
  /** 0 unspecified, 1 six, 2 eight. */
  digits: number;
  /** 0 unspecified, 1 HOTP, 2 TOTP. */
  type: number;
  counter: number;
}

class Reader {
  offset = 0;
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  get done(): boolean {
    return this.offset >= this.bytes.length;
  }

  varint(): number {
    let value = 0;
    let scale = 1;
    for (let i = 0; i < 10; i += 1) {
      if (this.offset >= this.bytes.length) throw new Error("truncated varint");
      const byte = this.bytes[this.offset++];
      value += (byte & 0x7f) * scale;
      if ((byte & 0x80) === 0) return value;
      scale *= 128;
    }
    throw new Error("varint too long");
  }

  bytesField(): Uint8Array {
    const length = this.varint();
    if (this.offset + length > this.bytes.length) throw new Error("truncated field");
    const out = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }

  skip(wireType: number): void {
    if (wireType === 0) this.varint();
    else if (wireType === 1) this.offset += 8;
    else if (wireType === 2) this.bytesField();
    else if (wireType === 5) this.offset += 4;
    else throw new Error(`unsupported wire type ${wireType}`);
  }
}

const utf8 = new TextDecoder();

function parseParameters(bytes: Uint8Array): MigrationEntry {
  const entry: MigrationEntry = { secret: new Uint8Array(), name: "", issuer: "", algorithm: 0, digits: 0, type: 0, counter: 0 };
  const reader = new Reader(bytes);
  while (!reader.done) {
    const tag = reader.varint();
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (field === 1 && wire === 2) entry.secret = reader.bytesField().slice();
    else if (field === 2 && wire === 2) entry.name = utf8.decode(reader.bytesField());
    else if (field === 3 && wire === 2) entry.issuer = utf8.decode(reader.bytesField());
    else if (field === 4 && wire === 0) entry.algorithm = reader.varint();
    else if (field === 5 && wire === 0) entry.digits = reader.varint();
    else if (field === 6 && wire === 0) entry.type = reader.varint();
    else if (field === 7 && wire === 0) entry.counter = reader.varint();
    else reader.skip(wire);
  }
  return entry;
}

export function parseMigrationPayload(bytes: Uint8Array): MigrationEntry[] {
  const entries: MigrationEntry[] = [];
  const reader = new Reader(bytes);
  while (!reader.done) {
    const tag = reader.varint();
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (field === 1 && wire === 2) entries.push(parseParameters(reader.bytesField()));
    else reader.skip(wire);
  }
  return entries;
}

function base64ToBytes(value: string): Uint8Array {
  // Raw "+" may have been turned into a space by query decoding.
  const clean = value.replace(/ /g, "+").replace(/-/g, "+").replace(/_/g, "/");
  const padded = clean + "=".repeat((4 - (clean.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

/** Decode the `data` parameter of an otpauth-migration link. */
export function decodeMigrationData(data: string): MigrationEntry[] {
  return parseMigrationPayload(base64ToBytes(data));
}

const ALGORITHMS: Record<number, MfaAlgorithm> = { 0: "SHA1", 1: "SHA1", 2: "SHA256", 3: "SHA512" };

/** Map one entry to an input, or explain why it cannot be imported. */
export function migrationEntryToInput(entry: MigrationEntry): { input: MfaAccountInput | null; error: string | null } {
  let issuer = entry.issuer.trim();
  let accountName = entry.name.trim();
  const colon = accountName.indexOf(":");
  if (colon > 0) {
    const prefix = accountName.slice(0, colon).trim();
    if (!issuer || prefix === issuer) {
      issuer = issuer || prefix;
      accountName = accountName.slice(colon + 1).trim();
    }
  }
  const algorithm = ALGORITHMS[entry.algorithm];
  if (!algorithm) return { input: null, error: "unsupported algorithm (MD5)" };
  if (entry.type !== 1 && entry.type !== 2 && entry.type !== 0) return { input: null, error: "unsupported OTP type" };
  if (entry.digits !== 0 && entry.digits !== 1 && entry.digits !== 2) return { input: null, error: "unsupported digit count" };
  return {
    error: null,
    input: {
      issuer,
      accountName,
      secret: encodeBase32(entry.secret),
      kind: entry.type === 1 ? "hotp" : "totp",
      algorithm,
      digits: entry.digits === 2 ? 8 : 6,
      period: 30,
      counter: entry.type === 1 ? entry.counter : 0,
      group: "",
      note: "",
    },
  };
}
