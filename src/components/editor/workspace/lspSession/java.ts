import { lspDiscoverJavaBundles, type LspJavaBundleConfig } from "../../../../lib/editor/lsp";
import { readLspJavaBundles } from "../codeWorkspaceModel";

export async function resolveJavaBundles(): Promise<LspJavaBundleConfig> {
  const configured = readLspJavaBundles();
  if (configured.javaDebugPath.trim() && configured.javaTestPath.trim()) return configured;

  try {
    const discovered = await lspDiscoverJavaBundles();
    return {
      javaDebugPath: configured.javaDebugPath.trim()
        || discovered.find((bundle) => bundle.id === "javaDebug")?.path
        || "",
      javaTestPath: configured.javaTestPath.trim()
        || discovered.find((bundle) => bundle.id === "javaTest")?.path
        || "",
    };
  } catch {
    // Discovery is opportunistic. Explicit configuration and normal LSP startup
    // must continue when no supported editor installation can be scanned.
    return configured;
  }
}
