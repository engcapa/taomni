import { createHash, createPublicKey, verify } from "node:crypto";
import { createReadStream, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function decodeBase64(value) {
  const encoded = value.trim();
  if (!encoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error("Invalid updater signature/public key base64 encoding");
  }
  return Buffer.from(encoded, "base64");
}

/** Match tauri-plugin-updater's Minisign verification, including the trusted comment. */
export async function verifyUpdaterSignature(bundle, encodedSignature, encodedPublicKey) {
  const publicLines = decodeBase64(encodedPublicKey).toString("utf8").trim().split(/\r?\n/);
  const publicBytes = decodeBase64(publicLines[1] ?? "");
  if (publicBytes.length !== 42 || !["Ed", "ED"].includes(publicBytes.subarray(0, 2).toString())) {
    throw new Error("Invalid Minisign public key");
  }
  const lines = decodeBase64(encodedSignature).toString("utf8").trim().split(/\r?\n/);
  const signatureBytes = decodeBase64(lines[1] ?? "");
  const globalSignature = decodeBase64(lines[3] ?? "");
  if (lines.length !== 4 || signatureBytes.length !== 74 || globalSignature.length !== 64 || !lines[2].startsWith("trusted comment: ")) {
    throw new Error("Invalid Minisign signature");
  }
  if (!signatureBytes.subarray(2, 10).equals(publicBytes.subarray(2, 10))) {
    throw new Error("Updater signature key does not match plugins.updater.pubkey");
  }
  const algorithm = signatureBytes.subarray(0, 2).toString();
  let signedBytes;
  if (algorithm === "ED") {
    const hash = createHash("blake2b512");
    for await (const chunk of createReadStream(bundle)) hash.update(chunk);
    signedBytes = hash.digest();
  } else if (algorithm === "Ed") {
    // Legacy Minisign signs raw bytes. Tauri's verifier also accepts this mode.
    signedBytes = readFileSync(bundle);
  } else {
    throw new Error("Unsupported Minisign signature algorithm");
  }
  const publicKey = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), publicBytes.subarray(10)]),
    format: "der", type: "spki",
  });
  const signature = signatureBytes.subarray(10);
  if (!verify(null, signedBytes, publicKey, signature)) throw new Error(`Invalid updater signature: ${bundle}`);
  const commentBytes = Buffer.from(lines[2].slice("trusted comment: ".length));
  if (!verify(null, Buffer.concat([signature, commentBytes]), publicKey, globalSignature)) {
    throw new Error(`Invalid updater trusted-comment signature: ${bundle}`);
  }
}

export async function verifyUpdaterAssets(directory, publicKey) {
  const signatures = readdirSync(directory).filter((name) => name.endsWith(".sig")).sort();
  if (!signatures.length) throw new Error("No updater signatures to verify");
  for (const name of signatures) {
    await verifyUpdaterSignature(join(directory, name.slice(0, -4)), readFileSync(join(directory, name), "utf8"), publicKey);
  }
  return signatures.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = process.argv[2];
  if (!directory) throw new Error("Usage: node scripts/verify-updater-signatures.mjs <staged-updater-assets-dir>");
  const config = JSON.parse(readFileSync(fileURLToPath(new URL("../src-tauri/tauri.conf.json", import.meta.url)), "utf8"));
  const count = await verifyUpdaterAssets(directory, config.plugins.updater.pubkey);
  console.log(`Verified ${count} updater signatures against plugins.updater.pubkey.`);
}
