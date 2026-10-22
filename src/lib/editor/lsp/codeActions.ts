import { invoke } from "@tauri-apps/api/core";
import {
  type LspDocumentDescriptor,
  type LspFormattingOptions,
  type LspFormattingResult,
  type LspRange,
  type LspCodeActionsResult,
  type LspCodeActionResolveResult,
} from "./types";
import { documentArgs } from "./documentArguments";

export function lspFormatting(
  descriptor: LspDocumentDescriptor,
  options?: LspFormattingOptions,
): Promise<LspFormattingResult> {
  return invoke<LspFormattingResult>("lsp_formatting", {
    ...documentArgs(descriptor),
    tabSize: options?.tabSize ?? null,
    insertSpaces: options?.insertSpaces ?? null,
  });
}

export function lspRangeFormatting(
  descriptor: LspDocumentDescriptor,
  range: LspRange,
  options?: LspFormattingOptions,
): Promise<LspFormattingResult> {
  return invoke<LspFormattingResult>("lsp_range_formatting", {
    ...documentArgs(descriptor),
    startLine: range.start.line,
    startCharacter: range.start.character,
    endLine: range.end.line,
    endCharacter: range.end.character,
    tabSize: options?.tabSize ?? null,
    insertSpaces: options?.insertSpaces ?? null,
  });
}

export function lspCodeActions(
  descriptor: LspDocumentDescriptor,
  range: LspRange,
  diagnostics?: unknown[] | null,
  only?: string[] | null,
): Promise<LspCodeActionsResult> {
  return invoke<LspCodeActionsResult>("lsp_code_actions", {
    ...documentArgs(descriptor),
    startLine: range.start.line,
    startCharacter: range.start.character,
    endLine: range.end.line,
    endCharacter: range.end.character,
    diagnostics: diagnostics ?? null,
    only: only?.length ? only : null,
  });
}

export function lspCodeActionResolve(
  descriptor: LspDocumentDescriptor,
  action: unknown,
): Promise<LspCodeActionResolveResult> {
  return invoke<LspCodeActionResolveResult>("lsp_code_action_resolve", {
    ...documentArgs(descriptor),
    action,
  });
}

export function lspExecuteCommand(
  descriptor: LspDocumentDescriptor,
  command: string,
  argumentsValue?: unknown,
): Promise<unknown> {
  const argumentsList = Array.isArray(argumentsValue)
    ? argumentsValue
    : argumentsValue == null
      ? []
      : [argumentsValue];
  return invoke<unknown>("lsp_execute_command", {
    ...documentArgs(descriptor),
    command,
    arguments: argumentsList,
  });
}
