import { invoke } from "@tauri-apps/api/core";
import {
  type LspJavaSettings,
  type LspJavaBundleConfig,
  type LspDiscoveredBundle,
  type LspDocumentDescriptor,
  type JavaTestItem,
  type JavaTestLaunch,
  type LspBuildStatus,
  type LspJavaProjectModelResult,
  type LspDownloadSourcesResult,
  type JavaModule,
} from "./types";
import { documentArgs } from "./documentArguments";

/** Apply the configured JDK for jdtls globally in the backend process. */
export function lspSetJavaHome(javaHome?: string | null): Promise<void> {
  return invoke("lsp_set_java_home", {
    javaHome: javaHome?.trim() || null,
  });
}

/**
 * Apply free-form jdtls JVM args globally (e.g. `-Xmx2G -XX:+UseG1GC`).
 * Null/empty restores the default `-Xms1024m -Xmx1024m`.
 * Returns the effective args string after normalize.
 */
export function lspSetJavaVmargs(vmargs?: string | null): Promise<string> {
  const value = vmargs?.trim() || null;
  return invoke<string>("lsp_set_java_vmargs", { vmargs: value });
}

/**
 * Apply jdtls `java.*` language settings (Lombok, autobuild, organize imports, …).
 * Live settings hot-update running jdtls sessions via didChangeConfiguration; the
 * Lombok `-javaagent` applies on the next workspace restart. `null` restores defaults.
 * Returns the number of sessions that received the live update.
 */
export function lspSetJavaSettings(settings: LspJavaSettings | null): Promise<number> {
  return invoke<number>("lsp_set_java_settings", { settings });
}

/** Persist jdtls extension bundle paths (applied on the next jdtls start). */
export function lspSetJavaBundles(config: LspJavaBundleConfig): Promise<void> {
  return invoke("lsp_set_java_bundles", { config });
}

/**
 * Scan installed editor extensions for java-debug / java-test plugin jars so the
 * user can adopt one without hunting for a path or downloading anything.
 */
export function lspDiscoverJavaBundles(): Promise<LspDiscoveredBundle[]> {
  return invoke<LspDiscoveredBundle[]>("lsp_discover_java_bundles");
}

/**
 * Discover test classes/methods in a Java file via the java-test bundle.
 * `descriptor` selects the jdtls session (its file URI is derived on the
 * backend). Returns [] when the file has no tests; rejects when no session /
 * bundle is available.
 */
export function javaTestDiscover(descriptor: LspDocumentDescriptor): Promise<JavaTestItem[]> {
  return invoke<JavaTestItem[]>("java_test_discover", {
    workspaceId: descriptor.workspaceId,
    rootPath: descriptor.rootPath ?? null,
    filePath: descriptor.filePath,
    // Bind discovery to the same jdtls session the editor uses (custom command).
    serverCommandId: descriptor.serverCommandId ?? null,
    customServerCommand: descriptor.customServerCommand ?? null,
  });
}

/** Resolve a JUnit launch config for a discovered test so it can be debugged. */
export function javaTestResolveLaunch(
  descriptor: LspDocumentDescriptor,
  test: JavaTestItem,
): Promise<JavaTestLaunch> {
  return invoke<JavaTestLaunch>("java_test_resolve_launch", {
    workspaceId: descriptor.workspaceId,
    rootPath: descriptor.rootPath ?? null,
    filePath: descriptor.filePath,
    test,
    serverCommandId: descriptor.serverCommandId ?? null,
    customServerCommand: descriptor.customServerCommand ?? null,
  });
}

/**
 * Build the project on the active language-server session (jdtls's
 * `java/buildWorkspace`). `descriptor` selects the session; `full` forces a clean
 * rebuild so diagnostics for unopened files are (re)published, while the debug
 * make-before-launch barrier passes `false` for an incremental build.
 */
export function lspBuildWorkspace(
  descriptor: LspDocumentDescriptor,
  full = true,
): Promise<LspBuildStatus> {
  return invoke<LspBuildStatus>("lsp_build_workspace", { ...documentArgs(descriptor), full });
}

export function lspJavaProjectModel(descriptor: LspDocumentDescriptor): Promise<LspJavaProjectModelResult> {
  return invoke<LspJavaProjectModelResult>("lsp_java_project_model", {
    ...documentArgs(descriptor),
    documentUri: descriptor.documentUri?.trim() || null,
  });
}

/**
 * On-demand "Download sources" for a Java library class (jdtls only). `descriptor`
 * must resolve to a file in the origin project (its session drives the download);
 * `uri` is the jdt:// class URI to refresh. Long-running: jdtls fetches the sources
 * JAR via Maven/Gradle before attached source replaces the decompiled bytecode.
 */
export function lspDownloadSources(
  descriptor: LspDocumentDescriptor,
  uri: string,
): Promise<LspDownloadSourcesResult> {
  return invoke<LspDownloadSourcesResult>("lsp_download_sources", {
    ...documentArgs(descriptor),
    uri,
  });
}

/**
 * Reload the Java project model (IDEA "Reload project") after a build file
 * (pom.xml / build.gradle) changed. Fire-and-forget: jdtls re-imports async.
 * `descriptor` should target the changed build file (or any project file).
 */
export function lspReloadProject(descriptor: LspDocumentDescriptor): Promise<void> {
  return invoke("lsp_reload_project", documentArgs(descriptor));
}

/**
 * List the Java projects/modules via jdtls `java.project.getAll`. `descriptor`
 * selects the jdtls session (any project file works). Returns [] when the server
 * lacks the command; rejects when no session is active.
 */
export function lspJavaModules(descriptor: LspDocumentDescriptor): Promise<JavaModule[]> {
  return invoke<JavaModule[]>("lsp_java_modules", documentArgs(descriptor));
}
