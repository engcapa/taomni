/** Absolute JDK home or `java`/`java.exe` path used to launch Eclipse JDT LS (needs 21+). */
export const LSP_JAVA_HOME_KEY = "taomni.codeWorkspace.lspJavaHome.v1";

/**
 * Free-form jdtls JVM args (space-separated), e.g. `-Xmx2G -XX:+UseG1GC`.
 * Empty → [`DEFAULT_LSP_JAVA_VMARGS`].
 */
export const LSP_JAVA_VMARGS_KEY = "taomni.codeWorkspace.lspJavaVmargs.v1";

/** Legacy heap-only key; migrated into vmargs on first read. */
export const LSP_JAVA_HEAP_MB_KEY = "taomni.codeWorkspace.lspJavaHeapMb.v1";

/** jdtls `java.*` language settings (Lombok, autobuild, organize imports, …). */
export const LSP_JAVA_SETTINGS_KEY = "taomni.codeWorkspace.lspJavaSettings.v1";

/** jdtls extension bundle paths (java-debug / java-test) for debug + test (M8). */
export const LSP_JAVA_BUNDLES_KEY = "taomni.codeWorkspace.lspJavaBundles.v1";
