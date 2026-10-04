import { strict as assert } from "node:assert";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { verifyUpdaterAssets, verifyUpdaterSignature } from "./verify-updater-signatures.mjs";

function fixture(t, algorithm = "ED") {
  const root = mkdtempSync(join(tmpdir(), "taomni-updater-signature-unit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyId = randomBytes(8);
  const rawPublicKey = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const pubkey = Buffer.from(`untrusted comment: minisign public key\n${Buffer.concat([Buffer.from("Ed"), keyId, rawPublicKey]).toString("base64")}\n`).toString("base64");
  const bytes = Buffer.from("exact bytes of the certificate-signed app archive\n");
  const bundle = join(root, "Taomni.app.tar.gz");
  writeFileSync(bundle, bytes);
  const payload = algorithm === "ED" ? createHash("blake2b512").update(bytes).digest() : bytes;
  const signature = sign(null, payload, privateKey);
  const comment = "timestamp:1791072000\tfile:Taomni.app.tar.gz";
  const globalSignature = sign(null, Buffer.concat([signature, Buffer.from(comment)]), privateKey);
  const signatureText = `untrusted comment: signature from minisign secret key\n${Buffer.concat([Buffer.from(algorithm), keyId, signature]).toString("base64")}\ntrusted comment: ${comment}\n${globalSignature.toString("base64")}\n`;
  const encoded = Buffer.from(signatureText).toString("base64");
  writeFileSync(`${bundle}.sig`, encoded);
  return { root, bundle, pubkey, encoded, signatureText };
}

for (const algorithm of ["ED", "Ed"]) {
  test(`accepts a valid ${algorithm} Tauri signature with its trusted comment`, async (t) => {
    const f = fixture(t, algorithm);
    assert.equal(await verifyUpdaterAssets(f.root, f.pubkey), 1);
  });
}

test("accepts the upstream Minisign prehashed test vector", async (t) => {
  const f = fixture(t);
  writeFileSync(f.bundle, "test");
  const pubkey = Buffer.from("untrusted comment: minisign public key\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n").toString("base64");
  const encoded = Buffer.from("untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1556193335\tfile:test\ny/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==\n").toString("base64");
  await verifyUpdaterSignature(f.bundle, encoded, pubkey);
});

test("rejects modified archives, a wrong release key and changed trusted comments", async (t) => {
  const f = fixture(t);
  const bytes = readFileSync(f.bundle);
  writeFileSync(f.bundle, Buffer.concat([bytes, Buffer.from("changed")]));
  await assert.rejects(verifyUpdaterAssets(f.root, f.pubkey), /Invalid updater signature/);
  writeFileSync(f.bundle, bytes);
  await assert.rejects(verifyUpdaterAssets(f.root, fixture(t).pubkey), /key does not match/);
  const changedComment = Buffer.from(f.signatureText.replace("timestamp:1791072000", "timestamp:1791072001")).toString("base64");
  await assert.rejects(verifyUpdaterSignature(f.bundle, changedComment, f.pubkey), /trusted-comment signature/);
});

test("rejects missing files, empty signatures, malformed base64 and unsupported algorithms", async (t) => {
  const f = fixture(t);
  for (const encoded of ["", "%%%", Buffer.from("incomplete").toString("base64")]) {
    await assert.rejects(verifyUpdaterSignature(f.bundle, encoded, f.pubkey));
  }
  const lines = f.signatureText.split("\n");
  const signature = Buffer.from(lines[1], "base64");
  signature.write("ZZ", 0);
  lines[1] = signature.toString("base64");
  await assert.rejects(verifyUpdaterSignature(f.bundle, Buffer.from(lines.join("\n")).toString("base64"), f.pubkey), /Unsupported Minisign/);
  rmSync(f.bundle);
  await assert.rejects(verifyUpdaterAssets(f.root, f.pubkey), /ENOENT/);
  rmSync(`${f.bundle}.sig`);
  await assert.rejects(verifyUpdaterAssets(f.root, f.pubkey), /No updater signatures/);
});
