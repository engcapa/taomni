import { type DbMetadataCache } from "../../../lib/dbMetadataCache";
import { type DbColumnDescription, type DbIndex } from "../../../lib/ipc";
import { type ObjectKind } from "../../../lib/sqlDialect";

export interface SchemaTreeProps {
  sessionId: string;
  engine: string;
  /** Called when one or more tree objects are selected. */
  onSelectionChange?: (objects: SchemaTreeSelectedObject[]) => void;
  /** Called when a tree object is double-clicked — inserts its schema-qualified name into the editor. */
  onInsertTable?: (table: string) => void;
  /** "Select top N rows" context action. */
  onQuickSelect?: (schema: string | null, table: string) => void;
  quickSelectLimit?: number;
  /** Presto catalog, needed to fully-qualify object names. */
  catalog?: string | null;
  /** Connection database name for engines where schemas live under a database. */
  databaseName?: string | null;
  /** Insert a full statement into a new query panel (for review/run). */
  onInsertSql?: (sql: string) => void;
  /** Open a fresh, empty query panel. */
  onNewQuery?: () => void;
  /** Make a schema the session default. */
  onSetDefaultSchema?: (schema: string) => void;
  /** Currently active schema/database (highlight + toolbar sync). */
  activeSchema?: string | null;
  /** Surface a transient status message. */
  onStatus?: (message: string) => void;
  /** Bubble up schema names for the editor toolbar selector. */
  onSchemasLoaded?: (schemas: string[]) => void;
  /** Bubble up the loaded schema → tables/columns for editor autocomplete. */
  onSchemaLoaded?: (tables: Map<string, string[]>) => void;
  /** Shared lazy metadata cache used by both schema tree and SQL editor. */
  metadataCache?: DbMetadataCache;
}

export interface SchemaTreeSelectedObject {
  schema: string | null;
  name: string;
  kind: ObjectKind;
}

export interface ObjNodeState {
  expanded: boolean;
  columns?: DbColumnDescription[];
  indexes?: DbIndex[];
  loading?: boolean;
}
