import {
  type BasicCompletionPolicyV2,
  type CompletionCaseMatching,
  type CompletionSortMode,
  type SymbolPatternRule,
  type WorkspaceCompletionPreferences,
  toBasicCompletionPolicyV2,
} from "../intelligencePreferences";
import { type CompletionPolicySnapshot, type CompletionInvocationReason } from "./types";


export class LspCompletionController {
  protected preferences: WorkspaceCompletionPreferences;
  protected revision = 1;
  protected listeners = new Set<(snapshot: CompletionPolicySnapshot) => void>();

  constructor(initialPreferences?: Partial<WorkspaceCompletionPreferences>) {
    this.preferences = {
      autoTrigger: true,
      triggerDelayMs: 50,
      minPrefixLength: 1,
      maxItems: 50,
      showDocumentation: true,
      documentationDelayMs: 250,
      caseMatching: "first-letter",
      sortMode: "provider-relevance",
      autoInsertSingle: false,
      excludedSymbols: [],
      prioritizedSymbols: [],
      ...initialPreferences,
    };
  }

  getRevision(): number {
    return this.revision;
  }

  getPreferences(): WorkspaceCompletionPreferences {
    return { ...this.preferences };
  }

  getPolicy(): BasicCompletionPolicyV2 {
    return toBasicCompletionPolicyV2(this.preferences);
  }

  getSnapshot(): CompletionPolicySnapshot {
    return {
      revision: this.revision,
      policy: this.getPolicy(),
      preferences: this.getPreferences(),
      provenance: { source: "workspace-preferences" },
    };
  }

  subscribe(listener: (snapshot: CompletionPolicySnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setPreferences(next: Partial<WorkspaceCompletionPreferences>): void {
    this.update(next);
  }

  update(next: Partial<WorkspaceCompletionPreferences>): CompletionPolicySnapshot {
    this.preferences = {
      ...this.preferences,
      ...next,
    };
    this.revision += 1;
    const snap = this.getSnapshot();
    for (const listener of this.listeners) {
      try {
        listener(snap);
      } catch {
        // Safe listener dispatch
      }
    }
    return snap;
  }

  shouldAutoTrigger(
    prefixLength: number,
    explicit: boolean,
    reason?: CompletionInvocationReason,
  ): boolean {
    if (explicit) return true;
    if (!this.preferences.autoTrigger) return false;
    if (reason === "trigger") return true;
    return prefixLength >= this.preferences.minPrefixLength;
  }

  getMaxItems(): number {
    return this.preferences.maxItems;
  }

  getTriggerDelayMs(): number {
    return this.preferences.triggerDelayMs;
  }

  getDocumentationDelayMs(): number {
    return this.preferences.documentationDelayMs;
  }

  shouldShowDocumentation(): boolean {
    return this.preferences.showDocumentation;
  }

  getCaseMatching(): CompletionCaseMatching {
    return this.preferences.caseMatching;
  }

  getSortMode(): CompletionSortMode {
    return this.preferences.sortMode;
  }

  getAutoInsertSingle(): boolean {
    return this.preferences.autoInsertSingle;
  }

  getExcludedSymbols(): readonly SymbolPatternRule[] {
    return this.preferences.excludedSymbols;
  }

  getPrioritizedSymbols(): readonly SymbolPatternRule[] {
    return this.preferences.prioritizedSymbols;
  }
}


/**
 * §8.23.6 X5: Canonical Workspace Completion Policy Controller with immutable snapshots,
 * monotonic revisions, and active subscriptions.
 */
export class WorkspaceCompletionPolicyController extends LspCompletionController { }
