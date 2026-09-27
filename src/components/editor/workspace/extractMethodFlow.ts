/**
 * ED-PARITY-007: pure model for the direct Java Extract Method transaction.
 *
 * The Code Workspace shell owns the async session, the provider calls and the
 * custom `TextInputDialog`; every decision that can be made from plain data
 * lives here so it can be tested without mounting the shell:
 *
 *  - candidate classification (`refactor.extract.function` / `.method` only),
 *  - the DEC-06 boundary wording for a zero-candidate result,
 *  - the unique new-method lookup that turns the post-extraction document
 *    symbol snapshot into a rename target,
 *  - the owner/receipt guards that stop a late `symbols-after`, prompt or
 *    rename reply from writing into a document the user has since changed.
 *
 * Nothing here reads React state or performs I/O.
 */
import type { LspDocumentSymbol, LspPosition, LspRange } from "../../../lib/editor/lsp";

/**
 * JDT LS `JavaCodeActionKind.REFACTOR_EXTRACT_METHOD` is
 * `refactor.extract.function` (title "Extract to method"); the generic
 * `refactor.extract.method` spelling is accepted as well. `refactor.extract`
 * alone is the parent kind and also covers variable/constant/field/interface
 * proposals, so it is deliberately NOT a method extraction signal.
 */
export const EXTRACT_METHOD_KINDS: readonly string[] = [
  "refactor.extract.function",
  "refactor.extract.method",
];

/** `Method` and `Function` from the LSP `SymbolKind` enumeration. */
const LSP_SYMBOL_KIND_METHOD = 6;
const LSP_SYMBOL_KIND_FUNCTION = 12;

export function isExtractMethodSymbolKind(kind: number): boolean {
  return kind === LSP_SYMBOL_KIND_METHOD || kind === LSP_SYMBOL_KIND_FUNCTION;
}

/**
 * True only for the method/function extraction kinds (including their
 * dot-separated sub-kinds). A missing kind is never a method extraction even
 * when the title reads "Extract to method", and the parent `refactor.extract`
 * kind keeps its variable/constant/field/interface members.
 */
export function isExtractMethodKind(kind: string | null | undefined): boolean {
  const value = (kind ?? "").trim();
  if (!value) return false;
  return EXTRACT_METHOD_KINDS.some((base) => value === base || value.startsWith(`${base}.`));
}

/**
 * DEC-06: the zero-candidate wording distinguishes "nothing is selected" from
 * "this selection cannot be extracted". Provider failure/timeout/cancel never
 * reaches this text (DEC-05 owns those).
 */
export function extractMethodBoundaryMessage(selectionEmpty: boolean): string {
  return selectionEmpty
    ? "Extract Method: select the statements or expression to extract"
    : "Extract Method is not available for this selection (the language server offers no extraction here, for example when several values would have to be returned)";
}

export type ExtractPhase =
  | "request"
  | "resolve"
  | "commit"
  | "symbols-after"
  | "naming"
  | "rename"
  | "finished";

export interface ExtractSelectionRange {
  start: LspPosition;
  end: LspPosition;
}

/**
 * One extraction attempt. The shell keeps exactly one of these in a ref and
 * replaces it on the next chord so a late reply can only ever see
 * `owner.sessionId !== current.id`.
 */
export interface ExtractSession {
  id: string;
  /** `workspaceInstanceId` of the tab that started the transaction. */
  workspaceInstance: string;
  /** Editor view (group) that owned the selection. */
  sourceViewId: string;
  fileKey: string;
  uri: string;
  providerGeneration: number;
  projectFingerprint: string;
  /** Revision/text of B0 at request time. */
  baseRevision: number;
  baseText: string;
  selection: ExtractSelectionRange;
  phase: ExtractPhase;
}

export interface ExtractOwnerSnapshot {
  sessionId: string;
  workspaceInstance: string;
  sourceViewId: string;
  fileKey: string;
  uri: string;
  providerGeneration: number;
  projectFingerprint: string;
}

export interface ExtractBufferSnapshot {
  revision: number;
  text: string;
}

/**
 * Frozen receipt of the committed extraction (B1). It is produced at the
 * canonical commit/history boundary and never re-read afterwards, so a later
 * user edit or undo cannot be mistaken for the extraction result.
 */
export interface ExtractReceipt {
  sessionId: string;
  fileKey: string;
  uri: string;
  postRevision: number;
  postText: string;
  historyId: string | null;
}

/**
 * Owner guard: the session, tab, view, document identity, provider generation
 * and project fingerprint must all still be the ones that started the attempt.
 * A closed-and-reopened file fails here because the shell drops the session on
 * close (and again on view change), so `sessionId` no longer matches.
 */
export function extractOwnerMatches(
  session: ExtractSession | null,
  owner: ExtractOwnerSnapshot | null,
): boolean {
  if (!session || !owner) return false;
  if (session.phase === "finished") return false;
  return session.id === owner.sessionId
    && session.workspaceInstance === owner.workspaceInstance
    && session.sourceViewId === owner.sourceViewId
    && session.fileKey === owner.fileKey
    && session.uri === owner.uri
    && session.providerGeneration === owner.providerGeneration
    && session.projectFingerprint === owner.projectFingerprint;
}

/**
 * Buffer guard: the live buffer must still be exactly the revision/text the
 * caller froze. Any user edit, undo/redo, watcher reload or external write
 * produces a different pair and aborts the pending step.
 */
export function extractBufferMatches(
  expected: ExtractBufferSnapshot | null,
  live: ExtractBufferSnapshot | null,
): boolean {
  if (!expected || !live) return false;
  return expected.revision === live.revision && expected.text === live.text;
}

/**
 * Receipt guard: after the extraction committed, the naming chain may only
 * continue while the document is still the exact B1 the receipt describes.
 * The live text is read at the moment of the check; a later revision is never
 * rebound to the receipt.
 */
export function extractReceiptMatches(
  receipt: ExtractReceipt | null,
  live: ExtractBufferSnapshot | null,
): boolean {
  if (!receipt || !live) return false;
  return receipt.postRevision === live.revision && receipt.postText === live.text;
}

/** Status line after skipping the naming step for an unsaved buffer (DEC-03). */
export function extractDirtyBufferMessage(defaultName: string): string {
  const name = defaultName.trim() || "method";
  return `Extracted method ${name}; save the file, then press Shift+F6 to rename it`;
}

/** Status line when the new method could not be identified unambiguously. */
export const EXTRACT_NAMING_UNAVAILABLE_MESSAGE =
  "Extracted method; could not locate the new method to rename it";

interface SymbolOccurrence {
  key: string;
  symbol: LspDocumentSymbol;
}

/**
 * Rebuilds the container chain from the flattened depth-annotated symbol list
 * and keys every method/function occurrence by container name chain + name.
 * Only names are used, so two different containers at the same depth are not
 * conflated.
 */
function methodOccurrences(
  symbols: readonly LspDocumentSymbol[],
): SymbolOccurrence[] {
  const ancestors: string[] = [];
  const occurrences: SymbolOccurrence[] = [];
  for (const symbol of symbols) {
    const rawDepth = Number.isFinite(symbol.depth) ? Math.trunc(symbol.depth) : 0;
    const depth = Math.max(0, Math.min(rawDepth, ancestors.length));
    ancestors.length = depth;
    if (isExtractMethodSymbolKind(symbol.kind)) {
      occurrences.push({
        key: [...ancestors, symbol.name].join("."),
        symbol,
      });
    }
    ancestors.push(symbol.name);
  }
  return occurrences;
}

/**
 * DEC-03: the rename target is the single method/function added to the
 * post-extraction snapshot. A new same-name member of an existing container is
 * an overload (ambiguous), and zero or several added methods are ambiguous
 * too — all of them return `null` instead of guessing.
 */
export function findExtractedMethodSymbol(
  before: readonly LspDocumentSymbol[],
  after: readonly LspDocumentSymbol[],
): LspDocumentSymbol | null {
  const beforeCounts = new Map<string, number>();
  for (const occurrence of methodOccurrences(before)) {
    beforeCounts.set(occurrence.key, (beforeCounts.get(occurrence.key) ?? 0) + 1);
  }
  const seenCounts = new Map<string, number>();
  const added: LspDocumentSymbol[] = [];
  for (const occurrence of methodOccurrences(after)) {
    const previous = beforeCounts.get(occurrence.key) ?? 0;
    const seen = (seenCounts.get(occurrence.key) ?? 0) + 1;
    seenCounts.set(occurrence.key, seen);
    if (seen <= previous) continue;
    if (previous > 0) {
      // A same-name member of a container that already had one: overload, not
      // the freshly extracted method.
      return null;
    }
    added.push(occurrence.symbol);
  }
  return added.length === 1 ? added[0] : null;
}

/** Rename position for the located method: start of its declaration name. */
export function extractedMethodRenamePosition(symbol: LspDocumentSymbol): LspPosition {
  const range: LspRange = symbol.selectionRange ?? symbol.range;
  return range.start;
}
