import type { PluginRecord } from "../pluginRegistry";
import { previewHelloManifest } from "../../stubs/modulePreview";

export function moduleRecord(lifecycle: PluginRecord["lifecycle"] = "enabled", version = "0.1.0"): PluginRecord {
  return { slug: "hello-plugin", manifest: { ...structuredClone(previewHelloManifest), version }, lifecycle };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
