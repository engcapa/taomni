import type { EffectiveCodeStyle } from "../codeStyleModel";
import type { LspDiagnostic, LspDocumentHighlight, LspInlayHint, LspSemanticToken } from "../../../../lib/editor/lsp";
import { type RunGutterTarget } from "../runGutter";
import { type GitLineChange } from "../gitEditorChrome";
import { type DebugBreakpointMarker } from "../debugEditorChrome";
import { type EditorAppearanceExtensionProfile } from "../editorAppearanceExtension";
import { type CodeMirrorHostProps } from "./types";


export const EMPTY_DIAGNOSTICS: LspDiagnostic[] = [];

export const EMPTY_HIGHLIGHTS: LspDocumentHighlight[] = [];

export const EMPTY_INLAY_HINTS: LspInlayHint[] = [];

export const EMPTY_RUN_GUTTER_TARGETS: RunGutterTarget[] = [];

export const EMPTY_SEMANTIC_TOKENS: LspSemanticToken[] = [];

export const EMPTY_GIT_CHANGES: GitLineChange[] = [];

export const EMPTY_DEBUG_BREAKPOINTS: DebugBreakpointMarker[] = [];

export const EMPTY_DEBUG_INLINE_VALUES: Record<string, string> = {};


/**
 * New empty-array props are common while LSP requests are debounced, and a
 * caller that rebuilds a derived array per render would otherwise force a full
 * compartment reconfigure on every keystroke. Callers should keep identities
 * stable; the element-wise pass is a cheap backstop for the ones that leak
 * (these arrays hold tens of entries, not thousands).
 */
export function sameArrayOrBothEmpty<T>(previous: readonly T[], next: readonly T[]): boolean {
  if (previous === next) return true;
  if (previous.length !== next.length) return false;
  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index] !== next[index]) return false;
  }
  return true;
}


/**
 * Inline values are rebuilt on every stop, so identity comparison alone would
 * reconfigure the editor even when the values did not change (stepping over a
 * line that touches nothing).
 */
export function sameInlineValues(
  previous: Record<string, string> | undefined,
  next: Record<string, string> | undefined,
): boolean {
  if (previous === next) return true;
  const a = previous ?? {};
  const b = next ?? {};
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => a[key] === b[key]);
}


export function sameCodeStyle(a?: EffectiveCodeStyle, b?: EffectiveCodeStyle): boolean {
  if (a === b) return true;
  return (a?.tabSize ?? 2) === (b?.tabSize ?? 2)
    && (a?.insertSpaces ?? true) === (b?.insertSpaces ?? true)
    && (a?.indentSize ?? 2) === (b?.indentSize ?? 2);
}


export const EMPTY_LIST: readonly never[] = [];


/**
 * ED-FOLLOW-004: bounds the pending local-document echo list by retained
 * bytes as well as entry count. Each echo holds a FULL document text so a
 * lagging controlled prop pins up to 64 whole copies (77 MiB per 1 MiB doc,
 * ~320 MiB per 5 MiB doc) until an exact (text, revision) echo matches —
 * and pins them permanently when it never does. Eviction is oldest-first,
 * which preserves the matching invariant: the consumer only ever matches
 * the latest prop snapshot, and an older-than-kept echo would have been
 * dropped by the consume splice anyway. Small docs are unaffected (64
 * short texts never reach the byte cap).
 */
export const MAX_PENDING_ECHO_CHARS = 8 * 1024 * 1024;

export const MAX_PENDING_ECHO_ENTRIES = 64;


export function trimPendingLocalDocumentEchoes(
  pendingEchoes: Array<{ text: string; expectedDocumentRevision: number }>,
  maxEntries: number = MAX_PENDING_ECHO_ENTRIES,
  maxChars: number = MAX_PENDING_ECHO_CHARS,
): void {
  if (pendingEchoes.length > maxEntries) {
    pendingEchoes.splice(0, pendingEchoes.length - maxEntries);
  }
  let total = 0;
  for (const entry of pendingEchoes) total += entry.text.length;
  while (pendingEchoes.length > 1 && total > maxChars) {
    total -= pendingEchoes[0]!.text.length;
    pendingEchoes.splice(0, 1);
  }
}


export function sameOptionalArray<T>(
  a?: readonly T[],
  b?: readonly T[],
  equal: (x: T, y: T) => boolean = (x, y) => x === y,
): boolean {
  if (a === b) return true;
  const arrA = a ?? EMPTY_LIST;
  const arrB = b ?? EMPTY_LIST;
  if (arrA.length !== arrB.length) return false;
  for (let i = 0; i < arrA.length; i++) {
    if (!equal(arrA[i] as T, arrB[i] as T)) return false;
  }
  return true;
}


export function sameEditorAppearance(
  a?: EditorAppearanceExtensionProfile,
  b?: EditorAppearanceExtensionProfile,
): boolean {
  return a === b || (
    !!a
    && !!b
    && a.fontFamily === b.fontFamily
    && a.fontSizePx === b.fontSizePx
    && a.lineHeight === b.lineHeight
    && a.ligatures === b.ligatures
    && a.colorSchemeId === b.colorSchemeId
    && a.highContrast === b.highContrast
    && a.virtualSpace?.afterLineEnd === b.virtualSpace?.afterLineEnd
    && a.virtualSpace?.atFileBottom === b.virtualSpace?.atFileBottom
  );
}


export function areCodeMirrorHostPropsEqual(prev: CodeMirrorHostProps, next: CodeMirrorHostProps): boolean {
  if (prev.path !== next.path) return false;
  if (prev.fileKey !== next.fileKey) return false;
  if (!sameOptionalArray(prev.retainedFileKeys, next.retainedFileKeys)) return false;
  if (prev.viewId !== next.viewId) return false;
  if (prev.transactionOwner !== next.transactionOwner) return false;
  if (prev.documentRevision !== next.documentRevision) return false;
  if (prev.doc !== next.doc) return false;
  if (prev.visible !== next.visible) return false;
  if (prev.active !== next.active) return false;
  if (prev.readOnly !== next.readOnly) return false;
  if (prev.renderedDocEnabled !== next.renderedDocEnabled) return false;
  if (prev.renderedDocLanguageId !== next.renderedDocLanguageId) return false;
  if (prev.softWrap !== next.softWrap) return false;
  if (!sameEditorAppearance(prev.appearance, next.appearance)) return false;
  if (prev.columnSelectionMode !== next.columnSelectionMode) return false;
  if (prev.showHoverDocumentation !== next.showHoverDocumentation) return false;
  if (prev.hoverDocumentationDelayMs !== next.hoverDocumentationDelayMs) return false;
  if (prev.parameterInfoRequestNonce !== next.parameterInfoRequestNonce) return false;
  if (prev.parameterInfoShowFullSignatures !== next.parameterInfoShowFullSignatures) return false;
  if (prev.parameterPopup !== next.parameterPopup) return false;
  if (prev.coverageEnabled !== next.coverageEnabled) return false;
  if (prev.fileCoverage !== next.fileCoverage) return false;
  if (prev.reveal !== next.reveal) return false;
  if (prev.gitBlame !== next.gitBlame) return false;
  if (prev.debugCurrentLine !== next.debugCurrentLine) return false;
  if (!sameCodeStyle(prev.codeStyle, next.codeStyle)) return false;
  if (!sameArrayOrBothEmpty(prev.diagnostics, next.diagnostics)) return false;
  if (!sameOptionalArray(prev.highlights, next.highlights)) return false;
  if (!sameOptionalArray(prev.inlayHints, next.inlayHints)) return false;
  if (!sameOptionalArray(prev.semanticTokens, next.semanticTokens)) return false;
  if (!sameOptionalArray(prev.gitChanges, next.gitChanges)) return false;
  if (!sameOptionalArray(prev.runGutterTargets, next.runGutterTargets)) return false;
  if (!sameOptionalArray(prev.debugBreakpoints, next.debugBreakpoints)) return false;
  if (!sameOptionalArray(prev.completionTriggers, next.completionTriggers)) return false;
  if (!sameOptionalArray(prev.signatureTriggers, next.signatureTriggers)) return false;
  if (prev.debugStep !== next.debugStep) return false;
  if (prev.debugRunToCursor !== next.debugRunToCursor) return false;
  if (prev.debugStop !== next.debugStop) return false;
  if (prev.debugEvaluate !== next.debugEvaluate) return false;
  if (prev.onPinHoverDoc !== next.onPinHoverDoc) return false;
  if (prev.onCommandPortChange !== next.onCommandPortChange) return false;
  return true;
}
