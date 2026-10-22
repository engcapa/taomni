export const WORD_PREFIX_PATTERN = String.raw`[\p{L}_][\p{L}\p{N}\p{M}_$]*`;

export const IDENT_PATTERN = String.raw`(?:"(?:[^"]|"")*"|` + "`(?:[^`]|``)*`" + String.raw`|\[[^\]]+\]|${WORD_PREFIX_PATTERN})`;

export const QUALIFIED_PATTERN = `${IDENT_PATTERN}(?:\\s*\\.\\s*${IDENT_PATTERN}){0,2}`;

export const QUOTED_PREFIX_PATTERN = String.raw`(?:"(?:[^"]|"")*|` + "`(?:[^`]|``)*" + String.raw`|\[(?:[^\]]|\]\])*)`;

export const COMPLETION_PREFIX_PATTERN = `(?:${WORD_PREFIX_PATTERN}|${QUOTED_PREFIX_PATTERN})`;

export const DOT_CONTEXT_RE = new RegExp(`(${QUALIFIED_PATTERN})\\.(${COMPLETION_PREFIX_PATTERN})?$`, "u");

export const RELATION_CONTEXT_RE = new RegExp(`\\b(?:from|join|update|into)\\s+(${COMPLETION_PREFIX_PATTERN})?$`, "iu");

export const INSERT_COLUMNS_CONTEXT_RE = new RegExp(
  `\\binsert\\s+into\\s+(${QUALIFIED_PATTERN})\\s*\\(([^)]*)$`,
  "iu",
);

export const JOIN_ON_CONTEXT_RE = new RegExp(
  `\\bjoin\\s+(${QUALIFIED_PATTERN})(?:\\s+(?:as\\s+)?(${IDENT_PATTERN}))?\\s+on\\s+(${WORD_PREFIX_PATTERN})?$`,
  "iu",
);

export const COMPLETION_PREFIX_FULL_RE = new RegExp(`^(?:${COMPLETION_PREFIX_PATTERN})?$`, "u");

export const BARE_IDENTIFIER_VALID_FOR = /^[\p{L}_][\p{L}\p{N}\p{M}_$]*$/u;

export const QUOTED_IDENTIFIER_VALID_FOR = /^(?:"(?:[^"]|"")*|`(?:[^`]|``)*|\[(?:[^\]]|\]\])*)$/u;

export const COMPLETION_BLOCKED_NODES = new Set(["String", "LineComment", "BlockComment"]);

export const RESERVED_AFTER_RELATION = new Set([
  "on",
  "using",
  "where",
  "join",
  "inner",
  "left",
  "right",
  "full",
  "cross",
  "group",
  "order",
  "having",
  "limit",
  "union",
  "as",
]);

export const SQL_SELECT_RELATION_LIMIT = 8;
