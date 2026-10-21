import { vfsReadText } from "../localVfs";
import { parity005Completion, parity005Enabled, parity005Resolve, parity005Root, parity005Status } from "../parity005Completion";
import { parity007ChangeDocument, parity007CloseDocument, parity007CodeActionResolve, parity007CodeActions, parity007DocumentSymbols, parity007DocumentPath, parity007Enabled, parity007OpenDocument, parity007PrepareRename, parity007Rename, parity007Root, parity007SaveDocument, parity007Status } from "../parity007Extract";
import { type InvokeArgs } from "./runtime";

export const STUB_LSP_PRESETS = [
  {
    id: "typescript-javascript",
    displayName: "TypeScript / JavaScript",
    documentLanguageIds: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
    fileExtensions: ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"],
    fileNames: [],
    commands: [
      {
        id: "typescript-language-server",
        label: "typescript-language-server",
        command: "typescript-language-server",
        args: ["--stdio"],
        installHint: "npm install -g typescript typescript-language-server",
        fallback: false,
      },
    ],
  },
  {
    id: "rust",
    displayName: "Rust",
    documentLanguageIds: ["rust"],
    fileExtensions: ["rs"],
    fileNames: [],
    commands: [{ id: "rust-analyzer", label: "rust-analyzer", command: "rust-analyzer", args: [], installHint: "rustup component add rust-analyzer", fallback: false }],
  },
  {
    id: "python",
    displayName: "Python",
    documentLanguageIds: ["python"],
    fileExtensions: ["py", "pyi"],
    fileNames: [],
    commands: [{ id: "pyright", label: "pyright-langserver", command: "pyright-langserver", args: ["--stdio"], installHint: "npm install -g pyright", fallback: false }],
  },
  {
    id: "go",
    displayName: "Go",
    documentLanguageIds: ["go"],
    fileExtensions: ["go"],
    fileNames: [],
    commands: [{ id: "gopls", label: "gopls", command: "gopls", args: [], installHint: "go install golang.org/x/tools/gopls@latest", fallback: false }],
  },
  {
    id: "java",
    displayName: "Java",
    documentLanguageIds: ["java"],
    fileExtensions: ["java"],
    fileNames: [],
    commands: [{
      id: "jdtls",
      label: "jdtls",
      command: "jdtls",
      args: [],
      installHint: "Requires JDK 21+ (current JDT LS). Install Eclipse JDT LS and ensure `jdtls` + java 21 are on PATH",
      fallback: false,
    }],
  },
  {
    id: "cpp",
    displayName: "C / C++",
    documentLanguageIds: ["c", "cpp"],
    fileExtensions: ["c", "h", "cc", "cpp", "cxx", "hpp", "hh", "hxx"],
    fileNames: [],
    commands: [{ id: "clangd", label: "clangd", command: "clangd", args: [], installHint: "Install LLVM clangd and ensure `clangd` is on PATH", fallback: false }],
  },
  {
    id: "kotlin",
    displayName: "Kotlin",
    documentLanguageIds: ["kotlin"],
    fileExtensions: ["kt", "kts"],
    fileNames: [],
    commands: [{ id: "kotlin-language-server", label: "kotlin-language-server", command: "kotlin-language-server", args: [], installHint: "Install kotlin-language-server and ensure it is on PATH", fallback: false }],
  },
  {
    id: "scala",
    displayName: "Scala",
    documentLanguageIds: ["scala"],
    fileExtensions: ["scala", "sc"],
    fileNames: [],
    commands: [{ id: "metals", label: "Metals", command: "metals", args: [], installHint: "Install Metals and ensure `metals` is on PATH", fallback: false }],
  },
  {
    id: "csharp",
    displayName: "C#",
    documentLanguageIds: ["csharp"],
    fileExtensions: ["cs", "csx"],
    fileNames: [],
    commands: [
      { id: "csharp-ls", label: "csharp-ls", command: "csharp-ls", args: ["--features", "metadata-uris"], installHint: "dotnet tool install -g csharp-ls", fallback: false },
      { id: "omnisharp", label: "OmniSharp", command: "omnisharp", args: ["--languageserver"], installHint: "Install OmniSharp and ensure `omnisharp` is on PATH", fallback: true },
    ],
  },
  {
    id: "swift",
    displayName: "Swift",
    documentLanguageIds: ["swift"],
    fileExtensions: ["swift"],
    fileNames: [],
    commands: [{ id: "sourcekit-lsp", label: "SourceKit-LSP", command: "sourcekit-lsp", args: [], installHint: "Install Swift toolchain and ensure `sourcekit-lsp` is on PATH", fallback: false }],
  },
];

export function stubLspPresetForPath(path: string) {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return STUB_LSP_PRESETS.find((preset) => preset.fileExtensions.includes(ext)) ?? null;
}

export function parity005DocumentPath(args?: InvokeArgs): string {
  const filePath = String(args?.filePath ?? "");
  return args?.rootPath === parity005Root
    ? `${parity005Root}/${filePath.replace(/^\/+/, "")}`
    : filePath;
}

export function stubLspDocumentStatus(args?: InvokeArgs) {
  const filePath = parity005DocumentPath(args);
  if (parity005Enabled(filePath)) return parity005Status(filePath);
  const editFilePath = parity007DocumentPath(args);
  if (parity007Enabled(editFilePath)) return parity007Status(editFilePath);
  const preset = stubLspPresetForPath(filePath);
  return {
    path: filePath,
    uri: filePath ? `file://${filePath}` : "",
    presetId: preset?.id ?? null,
    languageId: preset?.documentLanguageIds[0] ?? null,
    displayName: preset?.displayName ?? null,
    available: false,
    active: false,
    semanticReady: false,
    selectedCommandId: null,
    selectedCommand: null,
    installHint: preset?.commands[0]?.installHint ?? null,
    error: preset ? `${preset.displayName} language server is not available in browser preview` : "No language server preset for this file type",
  };
}

export function stubLspServerStatuses() {
  return STUB_LSP_PRESETS.map((preset) => ({
    presetId: preset.id,
    displayName: preset.displayName,
    documentLanguageIds: preset.documentLanguageIds,
    available: preset.id === "java" && (parity005Enabled() || parity007Enabled()),
    active: preset.id === "java" && (parity005Enabled() || parity007Enabled()),
    selectedCommandId: null,
    selectedCommand: null,
    installHint: preset.commands[0]?.installHint ?? "",
    error: preset.id === "java" && (parity005Enabled() || parity007Enabled())
      ? null
      : "Language servers are not available in browser preview",
    runtimeStatus: preset.id === "java"
      ? parity007Enabled()
        ? "B-007 controlled browser provider"
        : parity005Enabled() ? "B-005 controlled browser provider" : "Java not probed in browser preview — need JDK 21+ for jdtls"
      : null,
    commands: preset.commands.map((command) => ({
      ...command,
      available: preset.id === "java" && (parity005Enabled() || parity007Enabled()),
    })),
  }));
}

export async function invokeLsp<T>(cmd: string, args?: any): Promise<T> {
  switch (cmd) {

    case "lsp_list_presets": {
      return STUB_LSP_PRESETS as T;
    }

    case "lsp_set_java_home": {
      return undefined as T;
    }

    case "lsp_set_java_vmargs": {
      const raw = (args as { vmargs?: string | null } | undefined)?.vmargs;
      const trimmed = typeof raw === "string" ? raw.trim() : "";
      return (trimmed || "-Xms1024m -Xmx1024m") as T;
    }

    case "lsp_resolve_show_message_request": {
      return undefined as T;
    }

    case "lsp_cancel_work_done_progress": {
      return false as T;
    }

    case "lsp_detect_servers": {
      return stubLspServerStatuses() as T;
    }

    case "lsp_document_status": {
      return stubLspDocumentStatus(args as InvokeArgs) as T;
    }

    case "lsp_open_document":

    case "lsp_change_document":

    case "lsp_save_document":

    case "lsp_close_document": {
      // ED-PARITY-007: the controlled provider must follow the real document
      // lifecycle, otherwise a dirty buffer would still be served from the last
      // saved VFS bytes and the symbols-after/dirty scenarios would be vacuous.
      const documentPath = parity007DocumentPath(args as InvokeArgs);
      if (parity007Enabled(documentPath)) {
        const text = (args as InvokeArgs).text;
        if (cmd === "lsp_close_document") parity007CloseDocument(documentPath);
        else if (cmd === "lsp_open_document") parity007OpenDocument(documentPath, text as string | null);
        else if (cmd === "lsp_save_document") parity007SaveDocument(documentPath, text as string | null);
        else parity007ChangeDocument(documentPath, text as string | null);
      }
      return stubLspDocumentStatus(args as InvokeArgs) as T;
    }

    case "lsp_completion": {
      const path = parity005DocumentPath(args as InvokeArgs);
      if (parity005Enabled(path)) return await parity005Completion(path, args as InvokeArgs) as T;
      return { status: stubLspDocumentStatus(args as InvokeArgs), isIncomplete: false, items: [] } as T;
    }

    case "lsp_completion_resolve": {
      const path = parity005DocumentPath(args as InvokeArgs);
      if (parity005Enabled(path)) return await parity005Resolve(path, (args as InvokeArgs).item) as T;
      return { kind: "unavailable", reason: "no-active-session" } as T;
    }

    case "lsp_stop_workspace": {
      return 0 as T;
    }

    case "lsp_workspace_will_file_operation":

    case "lsp_workspace_did_file_operation": {
      return 0 as T;
    }

    case "lsp_get_diagnostics": {
      return {
        status: stubLspDocumentStatus(args as InvokeArgs),
        diagnostics: [],
      } as T;
    }

    case "lsp_hover": {
      const hoverArgs = args as InvokeArgs;
      const status = stubLspDocumentStatus(hoverArgs);
      const hoverPath = parity005DocumentPath(hoverArgs);
      // B-005 controlled provider: documentation for the identifier under the
      // pointer so browser QA can drive the IDEA hover popup lifecycle.
      if (parity005Enabled(hoverPath)) {
        const text = await vfsReadText(hoverPath).catch(() => "");
        const lineText = text.split("\n")[Number(hoverArgs?.line ?? -1)] ?? "";
        const character = Number(hoverArgs?.character ?? -1);
        let start = character;
        let end = character;
        while (start > 0 && /[\w$]/.test(lineText[start - 1] ?? "")) start -= 1;
        while (end < lineText.length && /[\w$]/.test(lineText[end] ?? "")) end += 1;
        const word = lineText.slice(start, end);
        if (word && /[A-Za-z_$]/.test(word[0] ?? "")) {
          const line = Number(hoverArgs?.line);
          return {
            status,
            contents: [
              "```java",
              `parity005.${word}`,
              "```",
              "",
              `Browser B-005 documentation for \`${word}\`.`,
              "",
              Array.from({ length: 12 }, (_, index) => `Line ${index + 1} of the ${word} description keeps the popup scrollable.`).join("\n\n"),
            ].join("\n"),
            range: { start: { line, character: start }, end: { line, character: end } },
          } as T;
        }
      }
      return {
        status,
        contents: null,
        range: null,
      } as T;
    }

    case "lsp_signature_help": {
      // Browser preview has no language server; the empty-signature shape
      // mirrors the native unavailable result (§8.20.2 W1).
      return {
        status: stubLspDocumentStatus(args as InvokeArgs),
        signatures: [],
        activeSignature: 0,
        activeParameter: 0,
      } as T;
    }

    case "lsp_java_project_model": {
      const editPath = parity007DocumentPath(args as InvokeArgs);
      if (parity007Enabled(editPath)) {
        return {
          status: parity007Status(editPath), active: true, processId: null,
          serverName: "B-007 controlled provider", serverVersion: "fixture",
          registeredCommands: [], buildFiles: [`${parity007Root}/pom.xml`],
          javaHomeUsed: null, javaProjects: [], classpathProbe: null,
          probeReason: "browser-controlled-provider",
        } as T;
      }
      const path = parity005DocumentPath(args as InvokeArgs);
      if (parity005Enabled(path)) {
        return {
          status: parity005Status(path), active: true, processId: null,
          serverName: "B-005 controlled provider", serverVersion: "fixture",
          registeredCommands: [], buildFiles: [`${parity005Root}/pom.xml`],
          javaHomeUsed: null, javaProjects: [], classpathProbe: null,
          probeReason: "browser-controlled-provider",
        } as T;
      }
      // §8.20.3 W2: lifecycle-only facts in browser mode — no provider, so
      // phase derivation degrades honestly instead of pretending readiness.
      return {
        status: stubLspDocumentStatus(args as InvokeArgs),
        active: false,
        processId: null,
        serverName: null,
        serverVersion: null,
        registeredCommands: [],
        buildFiles: [],
        javaHomeUsed: null,
        javaProjects: [],
        classpathProbe: null,
        probeReason: "no-active-session",
      } as T;
    }

    case "lsp_definition":

    case "lsp_declaration":

    case "lsp_type_definition":

    case "lsp_implementation":

    case "lsp_references": {
      return {
        status: stubLspDocumentStatus(args as InvokeArgs),
        locations: [],
      } as T;
    }

    case "lsp_workspace_symbols": {
      return {
        status: stubLspDocumentStatus(args as InvokeArgs),
        symbols: [],
        sessionCount: 0,
        providerCount: 0,
        skippedProviderCount: 0,
        failedProviderCount: 0,
        complete: false,
        truncated: false,
        diagnostics: ["Workspace symbols are not available in browser preview"],
      } as T;
    }

    case "lsp_workspace_symbol_resolve": {
      throw new Error("Workspace symbol resolution is not available in browser preview");
    }

    case "lsp_read_uri_contents": {
      const uri = String((args as InvokeArgs)?.uri ?? "");
      const title = uri.split("/").pop()?.split("?")[0] || "Library.java";
      const decompiled = uri.includes(".class");
      const banner = "// Source code is decompiled from a .class file using FernFlower decompiler (from Intellij IDEA).\n";
      return {
        status: stubLspDocumentStatus(args as InvokeArgs),
        uri,
        path: null,
        title: title.endsWith(".class") ? title.replace(/\.class$/, ".java") : title,
        container: uri.split("/").slice(-3, -1).reverse().join(" · ") || null,
        languageId: "java",
        text: `${decompiled ? banner : ""}// Stub library source for ${uri}\n`,
        readOnly: true,
        decompiled,
      } as T;
    }

    case "lsp_download_sources": {
      const uri = String((args as InvokeArgs)?.uri ?? "");
      // Stub pretends the sources JAR published, returning non-decompiled text.
      return {
        attached: true,
        text: `// Stub attached source for ${uri}\n`,
        decompiled: false,
        message: null,
      } as T;
    }

    case "lsp_prepare_call_hierarchy":

    case "lsp_prepare_type_hierarchy":

    case "lsp_type_hierarchy_supertypes":

    case "lsp_type_hierarchy_subtypes": {
      return {
        status: stubLspDocumentStatus(args as InvokeArgs),
        items: [],
      } as T;
    }

    case "lsp_call_hierarchy_incoming":

    case "lsp_call_hierarchy_outgoing": {
      return {
        status: stubLspDocumentStatus(args as InvokeArgs),
        entries: [],
      } as T;
    }

    case "lsp_document_highlights": {
      return {
        status: stubLspDocumentStatus(args as InvokeArgs),
        highlights: [],
      } as T;
    }

    case "lsp_inlay_hints": {
      return {
        status: stubLspDocumentStatus(args as InvokeArgs),
        hints: [],
      } as T;
    }

    case "lsp_selection_ranges": {
      return {
        status: stubLspDocumentStatus(args as InvokeArgs),
        ranges: [],
      } as T;
    }

    case "lsp_code_actions": {
      const path = parity007DocumentPath(args as InvokeArgs);
      if (parity007Enabled(path)) {
        return await parity007CodeActions(path, args as InvokeArgs) as T;
      }
      return {
        status: stubLspDocumentStatus(args as InvokeArgs),
        actions: [],
      } as T;
    }

    case "lsp_code_action_resolve": {
      const path = parity007DocumentPath(args as InvokeArgs);
      if (parity007Enabled(path)) {
        return await parity007CodeActionResolve(
          path,
          (args as InvokeArgs).action as Parameters<typeof parity007CodeActionResolve>[1],
          `${parity007Root}/src/main/java/demo/ExtractHelper.java`,
        ) as T;
      }
      return {
        status: stubLspDocumentStatus(args as InvokeArgs),
        action: null,
      } as T;
    }

    case "lsp_document_symbols": {
      const path = parity007DocumentPath(args as InvokeArgs);
      if (parity007Enabled(path)) return await parity007DocumentSymbols(path) as T;
      return {
        status: stubLspDocumentStatus(args as InvokeArgs),
        symbols: [],
      } as T;
    }

    case "lsp_prepare_rename": {
      const path = parity007DocumentPath(args as InvokeArgs);
      if (parity007Enabled(path)) {
        return await parity007PrepareRename(path, {
          line: Number((args as InvokeArgs).line ?? 0),
          character: Number((args as InvokeArgs).character ?? 0),
        }) as T;
      }
      return {
        status: stubLspDocumentStatus(args as InvokeArgs),
        range: null,
        placeholder: null,
        allowed: false,
        message: "Rename is not available in browser preview",
      } as T;
    }

    case "lsp_rename": {
      const path = parity007DocumentPath(args as InvokeArgs);
      if (parity007Enabled(path)) {
        return await parity007Rename(
          path,
          {
            line: Number((args as InvokeArgs).line ?? 0),
            character: Number((args as InvokeArgs).character ?? 0),
          },
          String((args as InvokeArgs).newName ?? ""),
        ) as T;
      }
      return {
        status: stubLspDocumentStatus(args as InvokeArgs),
        edit: { documentEdits: [], operations: [] },
      } as T;
    }

    case "lsp_semantic_tokens": {
      return {
        status: stubLspDocumentStatus(args as InvokeArgs),
        tokens: [],
      } as T;
    }

    // Java debug + extension bundles + java-tools provisioning have no
    // browser-preview backend: there is no JVM, jdtls session, or DAP adapter.
    // Answer the read-only status probes with "unavailable" shapes so Settings
    // and the workspace render, and hard-fail the action commands with a clear
    // desktop-only message instead of returning undefined (which crashed the
    // debug hook when it read `.sessionId`).
    case "lsp_set_java_bundles": {
      return undefined as T;
    }

    case "lsp_detect_java_bundles": {
      return [
        { id: "javaDebug", path: null, available: false },
        { id: "javaTest", path: null, available: false },
      ] as T;
    }

    case "lsp_discover_java_bundles": {
      // Browser preview has no filesystem scan; nothing discovered.
      return [] as T;
    }

    case "java_tools_status": {
      return {
        jdtls: { id: "jdtls", state: "missing", path: null, version: null },
        javaDebug: { id: "javaDebug", state: "missing", path: null, version: null },
        jdk: { compatible: false, version: null, path: null },
        desktopOnly: true,
      } as T;
    }

    case "java_tools_discover": {
      return [] as T;
    }

    case "dap_start_session":

    case "dap_send_request":

    case "dap_send":

    case "dap_terminate":

    case "java_debug_resolve_main_classes":

    case "java_tools_install":

    case "java_test_discover":

    case "java_test_resolve_launch": {
      throw new Error(
        `${cmd} is only available in the Taomni desktop app; the browser preview has no Java debug backend`,
      );
    }

    case "dependency_index_status": {
      return { kind: "available" } as T;
    }

    case "dependency_index_search": {
      const q = ((args?.query as string) || "").toLowerCase().trim();
      const mockResults = [
        { groupId: "org.springframework.boot", artifactId: "spring-boot-starter-web", version: "3.3.2", description: "Spring Boot Web Starter" },
        { groupId: "org.springframework.boot", artifactId: "spring-boot-starter-test", version: "3.3.2", description: "Spring Boot Test Starter" },
        { groupId: "org.junit.jupiter", artifactId: "junit-jupiter-api", version: "5.10.3", description: "JUnit Jupiter API" },
        { groupId: "org.junit.jupiter", artifactId: "junit-jupiter-engine", version: "5.10.3", description: "JUnit Jupiter Engine" },
        { groupId: "org.mockito", artifactId: "mockito-core", version: "5.12.0", description: "Mockito Core" },
        { groupId: "com.fasterxml.jackson.core", artifactId: "jackson-databind", version: "2.17.2", description: "Jackson Databind" },
        { groupId: "com.google.guava", artifactId: "guava", version: "33.2.1-jre", description: "Google Guava" },
        { groupId: "org.projectlombok", artifactId: "lombok", version: "1.18.34", description: "Project Lombok" },
      ];
      const matched = mockResults.filter((item) =>
        !q || item.groupId.toLowerCase().includes(q) || item.artifactId.toLowerCase().includes(q)
      );
      return matched as T;
    }

    case "dependency_index_versions": {
      const gid = (args?.groupId as string) || "";
      if (gid.includes("spring-boot")) {
        return [
          { version: "3.3.2", timestamp: 1720000000 },
          { version: "3.3.1", timestamp: 1718000000 },
          { version: "3.2.8", timestamp: 1715000000 },
        ] as T;
      }
      if (gid.includes("junit")) {
        return [
          { version: "5.10.3", timestamp: 1720000000 },
          { version: "5.10.2", timestamp: 1718000000 },
        ] as T;
      }
      return [
        { version: "1.0.0", timestamp: 1700000000 },
        { version: "1.1.0", timestamp: 1710000000 },
      ] as T;
    }
    default: throw new Error(`Unhandled lsp stub command: ${cmd}`);
  }
}
