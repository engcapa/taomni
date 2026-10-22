import { invoke } from "@tauri-apps/api/core";
import {
  type LspDocumentDescriptor,
  type LspWorkspaceSymbolsResult,
  type LspWorkspaceSymbol,
  type LspPosition,
  type LspReferenceRequestOptions,
  type LspHierarchyPrepareResult,
  type LspCallHierarchyResult,
  type LspTypeHierarchyResult,
  type LspDocumentHighlightsResult,
  type LspRange,
  type LspInlayHintsResult,
  type LspSelectionRangesResult,
  type LspSemanticTokensResult,
  type LspPrepareRenameResult,
  type LspRenameResult,
  type LspHoverResult,
  type LspLocationsResult,
  type LspUriContentsResult,
} from "./types";
import { documentArgs } from "./documentArguments";
import { invokeCancellable, nextLspRequestSequence } from "./cancellation";

export function lspWorkspaceSymbols(
  descriptor: LspDocumentDescriptor,
  query: string,
): Promise<LspWorkspaceSymbolsResult> {
  return invoke<LspWorkspaceSymbolsResult>("lsp_workspace_symbols", {
    ...documentArgs(descriptor),
    query,
  });
}

export function lspWorkspaceSymbolResolve(
  workspaceId: string,
  resolveToken: string,
): Promise<LspWorkspaceSymbol> {
  return invoke<LspWorkspaceSymbol>("lsp_workspace_symbol_resolve", {
    workspaceId,
    resolveToken,
  });
}

export function lspPrepareCallHierarchy(
  descriptor: LspDocumentDescriptor,
  position: LspPosition,
  options?: LspReferenceRequestOptions,
): Promise<LspHierarchyPrepareResult> {
  return invokeCancellable<LspHierarchyPrepareResult>(
    "lsp_prepare_call_hierarchy",
    {
      ...documentArgs(descriptor),
      line: position.line,
      character: position.character,
    },
    options,
  );
}

export function lspCallHierarchyIncoming(
  descriptor: LspDocumentDescriptor,
  item: unknown,
  options?: LspReferenceRequestOptions,
): Promise<LspCallHierarchyResult> {
  return invokeCancellable<LspCallHierarchyResult>(
    "lsp_call_hierarchy_incoming",
    { ...documentArgs(descriptor), item },
    options,
  );
}

export function lspCallHierarchyOutgoing(
  descriptor: LspDocumentDescriptor,
  item: unknown,
  options?: LspReferenceRequestOptions,
): Promise<LspCallHierarchyResult> {
  return invokeCancellable<LspCallHierarchyResult>(
    "lsp_call_hierarchy_outgoing",
    { ...documentArgs(descriptor), item },
    options,
  );
}

export function lspPrepareTypeHierarchy(
  descriptor: LspDocumentDescriptor,
  position: LspPosition,
  options?: LspReferenceRequestOptions,
): Promise<LspHierarchyPrepareResult> {
  return invokeCancellable<LspHierarchyPrepareResult>(
    "lsp_prepare_type_hierarchy",
    {
      ...documentArgs(descriptor),
      line: position.line,
      character: position.character,
    },
    options,
  );
}

export function lspTypeHierarchySupertypes(
  descriptor: LspDocumentDescriptor,
  item: unknown,
  options?: LspReferenceRequestOptions,
): Promise<LspTypeHierarchyResult> {
  return invokeCancellable<LspTypeHierarchyResult>(
    "lsp_type_hierarchy_supertypes",
    { ...documentArgs(descriptor), item },
    options,
  );
}

export function lspTypeHierarchySubtypes(
  descriptor: LspDocumentDescriptor,
  item: unknown,
  options?: LspReferenceRequestOptions,
): Promise<LspTypeHierarchyResult> {
  return invokeCancellable<LspTypeHierarchyResult>(
    "lsp_type_hierarchy_subtypes",
    { ...documentArgs(descriptor), item },
    options,
  );
}

export function lspDocumentHighlights(
  descriptor: LspDocumentDescriptor,
  position: LspPosition,
): Promise<LspDocumentHighlightsResult> {
  return invoke<LspDocumentHighlightsResult>("lsp_document_highlights", {
    ...documentArgs(descriptor),
    line: position.line,
    character: position.character,
  });
}

export function lspInlayHints(
  descriptor: LspDocumentDescriptor,
  range: LspRange,
): Promise<LspInlayHintsResult> {
  return invoke<LspInlayHintsResult>("lsp_inlay_hints", {
    ...documentArgs(descriptor),
    startLine: range.start.line,
    startCharacter: range.start.character,
    endLine: range.end.line,
    endCharacter: range.end.character,
  });
}

export function lspSelectionRanges(
  descriptor: LspDocumentDescriptor,
  position: LspPosition,
): Promise<LspSelectionRangesResult> {
  return invoke<LspSelectionRangesResult>("lsp_selection_ranges", {
    ...documentArgs(descriptor),
    line: position.line,
    character: position.character,
  });
}

export function lspSemanticTokens(
  descriptor: LspDocumentDescriptor,
): Promise<LspSemanticTokensResult> {
  return invoke<LspSemanticTokensResult>("lsp_semantic_tokens", {
    ...documentArgs(descriptor),
  });
}

export function lspPrepareRename(
  descriptor: LspDocumentDescriptor,
  position: LspPosition,
): Promise<LspPrepareRenameResult> {
  return invoke<LspPrepareRenameResult>("lsp_prepare_rename", {
    ...documentArgs(descriptor),
    line: position.line,
    character: position.character,
  });
}

export function lspRename(
  descriptor: LspDocumentDescriptor,
  position: LspPosition,
  newName: string,
): Promise<LspRenameResult> {
  return invoke<LspRenameResult>("lsp_rename", {
    ...documentArgs(descriptor),
    line: position.line,
    character: position.character,
    newName,
  });
}

/** LSP SymbolKind values treated as "classes" in Search Everywhere. */
export const LSP_CLASS_SYMBOL_KINDS = new Set([5, 10, 11, 23, 26]);

export function lspHover(
  descriptor: LspDocumentDescriptor,
  position: LspPosition,
  options?: {
    /** §8.18.6 provider cancellation key (workspace+file identity). */
    cancelKey?: string;
    /**
     * Monotonic request sequence; a higher seq for the same cancelKey
     * cancels the previous in-flight hover via `$/cancelRequest`.
     */
    requestSeq?: number;
  },
): Promise<LspHoverResult> {
  const cancelKey = options?.cancelKey?.trim() || null;
  const requestSeq = cancelKey
    ? options?.requestSeq ?? nextLspRequestSequence()
    : null;
  return invoke<LspHoverResult>("lsp_hover", {
    ...documentArgs(descriptor),
    line: position.line,
    character: position.character,
    cancelKey,
    requestSeq,
  });
}

export function lspDefinition(
  descriptor: LspDocumentDescriptor,
  position: LspPosition,
  options?: LspReferenceRequestOptions,
): Promise<LspLocationsResult> {
  return invokeCancellable<LspLocationsResult>(
    "lsp_definition",
    {
      ...documentArgs(descriptor),
      line: position.line,
      character: position.character,
    },
    options,
  );
}

export function lspDeclaration(
  descriptor: LspDocumentDescriptor,
  position: LspPosition,
  options?: LspReferenceRequestOptions,
): Promise<LspLocationsResult> {
  return invokeCancellable<LspLocationsResult>(
    "lsp_declaration",
    {
      ...documentArgs(descriptor),
      line: position.line,
      character: position.character,
    },
    options,
  );
}

export function lspTypeDefinition(
  descriptor: LspDocumentDescriptor,
  position: LspPosition,
  options?: LspReferenceRequestOptions,
): Promise<LspLocationsResult> {
  return invokeCancellable<LspLocationsResult>(
    "lsp_type_definition",
    {
      ...documentArgs(descriptor),
      line: position.line,
      character: position.character,
    },
    options,
  );
}

export function lspImplementation(
  descriptor: LspDocumentDescriptor,
  position: LspPosition,
  options?: LspReferenceRequestOptions,
): Promise<LspLocationsResult> {
  return invokeCancellable<LspLocationsResult>(
    "lsp_implementation",
    {
      ...documentArgs(descriptor),
      line: position.line,
      character: position.character,
    },
    options,
  );
}

/**
 * Load contents for a definition/reference URI that is not a workspace file
 * (JDK classes, dependency JARs via jdtls `java/classFileContents`, or absolute paths).
 */
export function lspReadUriContents(
  descriptor: LspDocumentDescriptor,
  uri: string,
): Promise<LspUriContentsResult> {
  return invoke<LspUriContentsResult>("lsp_read_uri_contents", {
    ...documentArgs(descriptor),
    uri,
  });
}

export function lspReferences(
  descriptor: LspDocumentDescriptor,
  position: LspPosition,
  includeDeclaration = true,
  options?: LspReferenceRequestOptions,
): Promise<LspLocationsResult> {
  return invokeCancellable<LspLocationsResult>(
    "lsp_references",
    {
      ...documentArgs(descriptor),
      line: position.line,
      character: position.character,
      includeDeclaration,
    },
    options,
  );
}
