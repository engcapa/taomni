export {
  type RefactorKind,
  type SafeDeleteAttestationV1,
  type DestructiveRefactorAvailability,
  type RefactorCompleteness,
  type RefactorUriOwner,
  type RefactorConflictV3,
  type RefactorConflictSource,
  type RefactorFactV4,
  type RefactorDocumentPreconditionV4,
  type RefactorPlanV4,
  type RefactorPlanV3,
  type WorkspaceEditRecoveryPlan,
  type RefactorGateDecision,
  type BuildRefactorPlanInput,
  type RefactorRecoveryDocumentSnapshot,
  type RefactorRecoveryJournalEntry,
  type RefactorRecoveryDocumentSnapshotV2,
  type RefactorRecoveryStatusV2,
  type RefactorRecoveryJournalEntryV2,
  type RefactorRecoveryResourceMoveV1,
  type RefactorJournalWriteResult,
  type RefactorRecoveryJournalListingV2,
  type RefactorRecoveryPreImageV2,
  type RefactorRecoveryJournalPreparation,
  type RefactorRecoveryMoveProof,
} from "./refactor/types";

export { evaluateDestructiveRefactorAvailability, refactorApplyGate, buildRefactorPlan, verifyExclusionSafety } from "./refactor/plan";

export { buildRefactorPostTextIndex, verifyRefactorPostHashes, resolveRefactorPostTextForDocument, verifyRefactorMovePostEndpoints } from "./refactor/postconditions";

export {
  buildRefactorRecoveryJournalEntry,
  recordRefactorRecoveryJournal,
  getRefactorRecoveryJournal,
  listRefactorRecoveryJournals,
  clearRefactorRecoveryJournal,
} from "./refactor/legacyJournal";

export {
  isRefactorRecoveryJournalEntryV2,
  recordRefactorRecoveryJournalV2,
  getRefactorRecoveryJournalV2,
  listRefactorRecoveryJournalsV2,
  updateRefactorRecoveryJournalV2,
  clearRefactorRecoveryJournalV2,
  isPendingRefactorRecoveryEntry,
  dismissRefactorRecoveryEntry,
} from "./refactor/journalStorage";

export {
  refactorJournalPostImageMatches,
  refactorJournalPreImageMatches,
  resolveRecoveryDocTarget,
  resolveRecoveryMoveProof,
  recoveryMoveProofMatches,
  prepareRefactorRecoveryJournalV2,
  buildTextWorkspaceEditRecoveryPlan,
} from "./refactor/journalPreparation";
