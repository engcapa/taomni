import { invoke } from "@tauri-apps/api/core";
import {
  type LspDocumentDescriptor,
  type LspPosition,
  type LspCompletionInvocation,
  type LspCompletionResult,
  type LspCompletionResolveResult,
  type LspReferenceRequestOptions,
  type LspSignatureHelpResult,
} from "./types";
import { documentArgs } from "./documentArguments";
import { recordQaCompletion } from "./qaCompletion";
import { nextLspRequestSequence } from "./cancellation";

export async function lspCompletion(
  descriptor: LspDocumentDescriptor,
  position: LspPosition,
  triggerCharacter?: string | null,
  invocation?: LspCompletionInvocation,
): Promise<LspCompletionResult> {
  const result = await invoke<LspCompletionResult>("lsp_completion", {
    ...documentArgs(descriptor),
    line: position.line,
    character: position.character,
    triggerCharacter: triggerCharacter ?? null,
    ...(invocation
      ? {
        invocationOrdinal: invocation.invocationOrdinal,
        requestedScope: invocation.requestedScope,
      }
      : {}),
  });
  if (__TAOMNI_QA_COMPLETION_OBSERVATION__) {
    recordQaCompletion({
      phase: "fetch",
      workspaceId: descriptor.workspaceId,
      filePath: descriptor.filePath,
      position,
      invocation: invocation ?? null,
      active: result.status.active,
      itemCount: result.items.length,
      items: result.items.filter((item) => /StringUtils|append/i.test(item.label)).slice(0, 40)
        .map((item) => ({ label: item.label, detail: item.detail, raw: item.raw, insertTextFormat: item.insertTextFormat })),
    });
  }
  return result;
}

export async function lspCompletionResolve(
  descriptor: LspDocumentDescriptor,
  item: unknown,
): Promise<LspCompletionResolveResult> {
  const result = await invoke<LspCompletionResolveResult>("lsp_completion_resolve", {
    ...documentArgs(descriptor),
    item,
  }).catch((error: unknown) => ({
    kind: "failed" as const,
    message: error instanceof Error ? error.message : String(error),
  }));
  if (__TAOMNI_QA_COMPLETION_OBSERVATION__) {
    recordQaCompletion({
      phase: "resolve",
      workspaceId: descriptor.workspaceId,
      filePath: descriptor.filePath,
      requestedRaw: item,
      result,
    });
  }
  return result;
}

export function lspSignatureHelp(
  descriptor: LspDocumentDescriptor,
  position: LspPosition,
  triggerCharacter?: string | null,
  options?: LspReferenceRequestOptions,
): Promise<LspSignatureHelpResult> {
  const cancelKey = options?.cancelKey?.trim() || null;
  const requestSeq = cancelKey
    ? options?.requestSeq ?? nextLspRequestSequence()
    : null;
  return invoke<LspSignatureHelpResult>("lsp_signature_help", {
    ...documentArgs(descriptor),
    line: position.line,
    character: position.character,
    triggerCharacter: triggerCharacter ?? null,
    cancelKey,
    requestSeq,
  });
}
