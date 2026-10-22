export {
  getFilteredMatches,
  isSyntaxFilterAvailable,
  matchContextFilter,
  selectAllOccurrences,
  type SearchContextFilter,
  type SearchFilterOptions,
} from "./searchPanel/filtering";

export { applyPreserveCase, detectCasing, replaceAllPreserveCase, replaceNextPreserveCase, type CasingStyle } from "./searchPanel/replacement";

export { SEARCH_HISTORY_LIMIT, readSearchHistory, recordSearchHistory, resetSearchHistoryForTests, type SearchHistoryKind } from "./searchPanel/history";

export { createWorkspaceSearchPanel, openWorkspaceReplacePanel } from "./searchPanel/panel";

export { WORKSPACE_SEARCH_STYLE } from "./searchPanel/style";
