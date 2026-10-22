export {
  type BuildReplaceEditParams,
  type CollectReplacePreimagesParams,
  type ConflictCheckResult,
  type FileRevisionGuard,
  type ReplaceApplyOutcomeLike,
  type ReplaceCommitReport,
  type ReplaceFilePreimage,
  type ReplaceInFilesMatch,
  type ReplaceInFilesPlan,
  type ReplaceMatchFreshnessConflict,
  type ReplacePreflightConflict,
  type ReplacePreflightFileInput,
  type ReplacePreflightResult,
  type ReplacePrepareOptions,
  type ReplacePrepareRequestIdentity,
  type ReplacePreviewSnapshot,
  type ReplaceQueryIdentity,
  type ReplaceScopeIdentity,
  type ReplaceSelectionValidation,
} from "./replaceModel/model";

export {
  InvalidSearchMatchCoordinatesError,
  codePointOffsetToUtf16Offset,
  codePointOffsetToUtf16OffsetChecked,
  replaceMatchAbsolutePath,
  searchMatchesToReplaceInputs,
} from "./replaceModel/coordinates";

export { buildReplaceInFilesWorkspaceEdit, createReplaceInFilesPlan, validateReplacePreconditions, verifyReplaceMatchFreshness } from "./replaceModel/planning";

export { collectReplacePreimages, findReplacePreimage, replacePreimageExpectedHashes, replacePreimagePathKey, replaceScopeIdentityFromPlan } from "./replaceModel/preimages";

export { replaceEditSignature, replaceMatchStableKey, validateReplacePreviewSelection } from "./replaceModel/selection";

export { validateReplacePreflight } from "./replaceModel/preflight";

export { summarizeReplaceCommitReport } from "./replaceModel/report";
