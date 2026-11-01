import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = resolve(process.argv[2] ?? join(root, "src-tauri/Cargo.toml"));

function cargo(args) {
  const result = spawnSync("cargo", [...args, "--manifest-path", manifest], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`cargo ${args.join(" ")} failed (${result.status}):\n${result.stderr}`);
  }
  return result.stdout;
}

// rust-cache prunes files under target/sherpa-onnx-prebuilt but retains the
// dependency's build-script output. Cargo then considers it fresh, while the
// linker sees missing native libraries and Windows has no runtime DLLs.
const metadata = JSON.parse(cargo(["metadata", "--no-deps", "--format-version", "1"]));
const target = resolve(metadata.target_directory);
const prebuilt = join(target, "sherpa-onnx-prebuilt");
if (dirname(prebuilt) !== target) throw new Error(`Invalid sherpa cache path: ${prebuilt}`);

// Invalidate the build script AND remove the empty lib/ directories: upstream
// treats an existing lib/ as a complete download. Rebuilding also restores DLLs
// beside the profile's executables, which rust-cache removes separately.
cargo(["clean", "--package", "sherpa-onnx-sys"]);
rmSync(prebuilt, { recursive: true, force: true });
console.log(`Refreshed sherpa-onnx build state and native cache: ${prebuilt}`);
