import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fetchPublishedModuleAssets } from "./fetch-published-module-assets.mjs";
import { createHash } from "node:crypto";

test("fetches every published package and recreates detached sidecars", async () => {
  const root = mkdtempSync(join(tmpdir(), "taomni-module-assets-"));
  try {
    const bytes = new TextEncoder().encode("published package");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const packageUrl = "https://github.com/engcapa/taomni/releases/download/v0.6.0/taomni-plugin-mfa-0.1.0-linux-x86_64.taomni-plugin";
    const signature = "signed package\n";
    const catalog = { plugins: { "taomni-plugin-mfa": { id: "taomni-plugin-mfa", platforms: { "linux-x86_64": { url: packageUrl, sha256: digest, signature } } } } };
    const catalogDir = join(root, "catalog");
    const output = join(root, "assets");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(catalogDir);
    writeFileSync(join(catalogDir, "modules.json"), JSON.stringify(catalog));
    const entries = await fetchPublishedModuleAssets(catalogDir, output, async () => new Response(bytes, { status: 200 }));
    assert.deepEqual(entries, [{ id: "taomni-plugin-mfa", platform: "linux-x86_64", name: "taomni-plugin-mfa-0.1.0-linux-x86_64.taomni-plugin" }]);
    assert.deepEqual(readFileSync(join(output, entries[0].name)), Buffer.from(bytes));
    assert.equal(readFileSync(join(output, `${entries[0].name}.minisig`), "utf8"), signature);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
