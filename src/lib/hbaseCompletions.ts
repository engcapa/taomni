/**
 * CodeMirror autocomplete source for the HBase shell editor.
 *
 * The shared `SqlEditorPanel` is built on `@codemirror/lang-sql`, whose default
 * completion offers SQL keywords (SELECT, FROM, WHERE, …) — meaningless for the
 * HBase shell. This module produces a completion source that replaces those with
 * the HBase shell command verbs, option-map keys, and the live table / column
 * family names, so the editor suggests what the backend can actually run.
 *
 * Command verbs are driven by `HBASE_COMMANDS` (the single source of truth that
 * mirrors the backend `parse_shell_command`) and filtered by the active
 * transport, so REST sessions are never offered admin-only verbs like `alter`.
 */
import type { Completion, CompletionSource } from "@codemirror/autocomplete";
import { HBASE_COMMANDS, commandSupported, type HBaseTransport } from "./hbaseCommands";

/**
 * Option keys that appear inside scan/get/alter option maps
 * (`scan 't', {LIMIT => 10}`). Offered at argument position.
 */
const HBASE_OPTION_KEYWORDS = [
  "LIMIT",
  "STARTROW",
  "STOPROW",
  "ROWPREFIXFILTER",
  "COLUMN",
  "COLUMNS",
  "CACHE",
  "CACHE_BLOCKS",
  "FILTER",
  "TIMESTAMP",
  "TIMERANGE",
  "VERSIONS",
  "REVERSED",
  "RAW",
  "NAME",
  "REPLICATION_SCOPE",
  "IN_MEMORY",
  "BLOOMFILTER",
  "COMPRESSION",
  "TTL",
  "BLOCKSIZE",
  "FORMATTER",
];

export interface HBaseCompletionContext {
  transport: HBaseTransport;
  /** Table name → column families, from the loaded object tree. */
  schema?: Record<string, string[]>;
}

/** A word (option-map key, table name, …) at the cursor we complete against. */
const WORD_RE = /[A-Za-z_][\w]*$/;

/**
 * Build a CodeMirror completion source for an HBase shell editor. The result is
 * stable for a given (transport, schema) pair and is meant to be passed as an
 * `autocompletion({ override: [...] })` source so it fully replaces lang-sql's
 * keyword completion.
 */
export function hbaseCompletionSource({
  transport,
  schema,
}: HBaseCompletionContext): CompletionSource {
  const commandCompletions: Completion[] = HBASE_COMMANDS.filter((c) =>
    commandSupported(c.verb, transport),
  ).map((c) => ({
    label: c.verb,
    type: "keyword",
    detail: c.syntax,
    info: c.description,
    // Insert just the verb; the user types the arguments (the Commands palette
    // is where a full example template is inserted).
    apply: c.verb,
    boost: 1,
  }));

  const optionCompletions: Completion[] = HBASE_OPTION_KEYWORDS.map((k) => ({
    label: k,
    type: "property",
  }));

  const tableCompletions: Completion[] = Object.keys(schema ?? {}).map((table) => ({
    label: table,
    type: "type",
    detail: "table",
  }));

  const familySet = new Set<string>();
  for (const families of Object.values(schema ?? {})) {
    for (const family of families) familySet.add(family);
  }
  const familyCompletions: Completion[] = [...familySet].map((family) => ({
    label: family,
    type: "property",
    detail: "column family",
  }));

  const argCompletions = [...optionCompletions, ...tableCompletions, ...familyCompletions];

  return (context) => {
    const word = context.matchBefore(WORD_RE);
    if (!word && !context.explicit) return null;
    const from = word ? word.from : context.pos;
    // Don't pop up on an empty word unless explicitly requested (Ctrl-Space).
    if (word && word.from === word.to && !context.explicit) return null;

    // A new statement starts at the beginning of a line or after a top-level
    // `;`. If only whitespace precedes the cursor in that segment, we're at the
    // command verb; otherwise we're inside the arguments.
    const line = context.state.doc.lineAt(from);
    const before = context.state.sliceDoc(line.from, from);
    const segment = before.slice(before.lastIndexOf(";") + 1);
    const atCommandPosition = /^\s*$/.test(segment);

    const options = atCommandPosition ? commandCompletions : argCompletions;
    if (options.length === 0) return null;
    return { from, options, validFor: /^[\w]*$/ };
  };
}
