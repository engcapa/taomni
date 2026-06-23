import {
  dbDescribeTable,
  dbListCatalogs,
  dbListSchemas,
  dbListTables,
  type DbColumnDescription,
  type DbTable,
} from "./ipc";

export const DB_METADATA_TTL_MS = 10 * 60 * 1000;
export const DB_METADATA_COMPLETION_LIMIT = 500;

type CacheKind = "catalogs" | "schemas" | "tables" | "columns";

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export interface DbMetadataCacheOptions {
  sessionId: string;
  defaultCatalog?: string | null;
  ttlMs?: number;
  now?: () => number;
}

export interface DbMetadataTarget {
  catalog?: string | null;
  schema?: string | null;
  table?: string | null;
  all?: boolean;
}

export interface SqlMetadataInvalidationContext {
  engine: string;
  activeSchema?: string | null;
  defaultCatalog?: string | null;
}

type Listener = () => void;

function normalize(value?: string | null): string {
  return value?.trim() ?? "";
}

function truthy(value?: string | null): string | null {
  const normalized = normalize(value);
  return normalized ? normalized : null;
}

function unquoteIdent(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("`") && trimmed.endsWith("`")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    return trimmed
      .slice(1, -1)
      .replace(/""/g, '"')
      .replace(/``/g, "`")
      .replace(/]]/g, "]");
  }
  return trimmed;
}

const IDENT_PATTERN = String.raw`(?:"(?:[^"]|"")*"|` + "`(?:[^`]|``)*`" + String.raw`|\[[^\]]+\]|[A-Za-z_][\w$]*)`;
const QUALIFIED_PATTERN = `${IDENT_PATTERN}(?:\\s*\\.\\s*${IDENT_PATTERN}){0,2}`;

export function splitSqlQualifiedName(input: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "`" | "]" | null = null;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quote) {
      current += ch;
      if (
        (quote === '"' && ch === '"' && input[i + 1] === '"') ||
        (quote === "`" && ch === "`" && input[i + 1] === "`") ||
        (quote === "]" && ch === "]" && input[i + 1] === "]")
      ) {
        current += input[i + 1];
        i += 1;
        continue;
      }
      if ((quote === '"' && ch === '"') || (quote === "`" && ch === "`") || (quote === "]" && ch === "]")) {
        quote = null;
      }
      continue;
    }
    if (ch === '"') {
      quote = '"';
      current += ch;
      continue;
    }
    if (ch === "`") {
      quote = "`";
      current += ch;
      continue;
    }
    if (ch === "[") {
      quote = "]";
      current += ch;
      continue;
    }
    if (ch === ".") {
      const part = current.trim();
      if (part) parts.push(unquoteIdent(part));
      current = "";
      continue;
    }
    current += ch;
  }

  const part = current.trim();
  if (part) parts.push(unquoteIdent(part));
  return parts;
}

function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--.*$/gm, " ");
}

function resolveMetadataTarget(
  parts: string[],
  context: SqlMetadataInvalidationContext,
): DbMetadataTarget {
  if (context.engine === "Presto") {
    if (parts.length >= 3) {
      return { catalog: parts[0], schema: parts[1], table: parts[2] };
    }
    if (parts.length === 2) {
      return { catalog: context.defaultCatalog ?? null, schema: parts[0], table: parts[1] };
    }
    return { catalog: context.defaultCatalog ?? null, schema: context.activeSchema ?? null, table: parts[0] };
  }
  if (parts.length >= 2) {
    return { schema: parts[parts.length - 2], table: parts[parts.length - 1] };
  }
  return { schema: context.activeSchema ?? null, table: parts[0] };
}

export function sqlMetadataInvalidationTarget(
  sql: string,
  context: SqlMetadataInvalidationContext,
): DbMetadataTarget | null {
  const cleaned = stripSqlComments(sql).trim();
  if (!/^(create|alter|drop|rename|truncate)\b/i.test(cleaned)) return null;
  if (/^(create|alter|drop|rename)\s+(database|schema)\b/i.test(cleaned)) {
    return { all: true };
  }

  const patterns = [
    new RegExp(
      String.raw`\b(?:create|alter|drop)\s+(?:temporary\s+)?(?:materialized\s+view|table|view)\s+(?:if\s+(?:not\s+)?exists\s+)?(${QUALIFIED_PATTERN})`,
      "i",
    ),
    new RegExp(String.raw`\btruncate\s+(?:table\s+)?(${QUALIFIED_PATTERN})`, "i"),
    new RegExp(String.raw`\brename\s+table\s+(${QUALIFIED_PATTERN})`, "i"),
  ];

  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    if (!match?.[1]) continue;
    const parts = splitSqlQualifiedName(match[1]);
    if (parts.length === 0) break;
    return resolveMetadataTarget(parts, context);
  }

  return { catalog: context.defaultCatalog ?? null, schema: context.activeSchema ?? null };
}

export class DbMetadataCache {
  private readonly sessionId: string;
  private readonly defaultCatalog: string | null;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, CacheEntry<unknown>>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly listeners = new Set<Listener>();

  constructor(options: DbMetadataCacheOptions) {
    this.sessionId = options.sessionId;
    this.defaultCatalog = truthy(options.defaultCatalog);
    this.ttlMs = options.ttlMs ?? DB_METADATA_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getDefaultCatalog(): string | null {
    return this.defaultCatalog;
  }

  async listCatalogs(): Promise<string[]> {
    return this.cached(this.key("catalogs"), async () =>
      (await dbListCatalogs(this.sessionId)).map((catalog) => catalog.name),
    );
  }

  async listSchemas(catalog?: string | null): Promise<string[]> {
    const resolvedCatalog = this.resolveCatalog(catalog);
    return this.cached(this.key("schemas", resolvedCatalog), async () =>
      (await dbListSchemas(this.sessionId, resolvedCatalog || null)).map((schema) => schema.name),
    );
  }

  async listTables(schema: string | null, catalog?: string | null): Promise<DbTable[]> {
    const resolvedCatalog = this.resolveCatalog(catalog);
    const resolvedSchema = normalize(schema);
    return this.cached(this.key("tables", resolvedCatalog, resolvedSchema), () =>
      dbListTables(this.sessionId, resolvedSchema || null, resolvedCatalog || null),
    );
  }

  async describeTable(
    schema: string | null,
    table: string,
    catalog?: string | null,
  ): Promise<DbColumnDescription[]> {
    const resolvedCatalog = this.resolveCatalog(catalog);
    const resolvedSchema = normalize(schema);
    const resolvedTable = normalize(table);
    return this.cached(this.key("columns", resolvedCatalog, resolvedSchema, resolvedTable), () =>
      dbDescribeTable(this.sessionId, resolvedSchema || null, resolvedTable, resolvedCatalog || null),
    );
  }

  peekCatalogs(): string[] | null {
    return this.peek(this.key("catalogs"));
  }

  peekSchemas(catalog?: string | null): string[] | null {
    return this.peek(this.key("schemas", this.resolveCatalog(catalog)));
  }

  peekTables(schema: string | null, catalog?: string | null): DbTable[] | null {
    return this.peek(this.key("tables", this.resolveCatalog(catalog), normalize(schema)));
  }

  peekColumns(
    schema: string | null,
    table: string,
    catalog?: string | null,
  ): DbColumnDescription[] | null {
    return this.peek(this.key("columns", this.resolveCatalog(catalog), normalize(schema), normalize(table)));
  }

  clearAll(): void {
    this.entries.clear();
    this.inFlight.clear();
    this.notify();
  }

  invalidate(target: DbMetadataTarget): void {
    if (target.all) {
      this.clearAll();
      return;
    }
    const catalog = this.resolveCatalog(target.catalog);
    const schema = normalize(target.schema);
    const table = normalize(target.table);
    let changed = false;

    for (const key of Array.from(this.entries.keys())) {
      if (target.table) {
        if (key === this.key("columns", catalog, schema, table) || key === this.key("tables", catalog, schema)) {
          changed = this.entries.delete(key) || changed;
        }
      } else if (target.schema) {
        if (
          key === this.key("tables", catalog, schema) ||
          key.startsWith(`${this.key("columns", catalog, schema)}|`)
        ) {
          changed = this.entries.delete(key) || changed;
        }
      } else if (target.catalog) {
        if (
          key === this.key("schemas", catalog) ||
          key.startsWith(`${this.key("tables", catalog)}|`) ||
          key.startsWith(`${this.key("columns", catalog)}|`)
        ) {
          changed = this.entries.delete(key) || changed;
        }
      }
    }

    for (const key of Array.from(this.inFlight.keys())) {
      if (
        (target.table && (key === this.key("columns", catalog, schema, table) || key === this.key("tables", catalog, schema))) ||
        (target.schema && (key === this.key("tables", catalog, schema) || key.startsWith(`${this.key("columns", catalog, schema)}|`))) ||
        (target.catalog && (key === this.key("schemas", catalog) || key.startsWith(`${this.key("tables", catalog)}|`) || key.startsWith(`${this.key("columns", catalog)}|`)))
      ) {
        this.inFlight.delete(key);
      }
    }

    if (changed) this.notify();
  }

  invalidateSql(sql: string, context: SqlMetadataInvalidationContext): void {
    const target = sqlMetadataInvalidationTarget(sql, context);
    if (target) this.invalidate(target);
  }

  private async cached<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
    const existing = this.entries.get(key) as CacheEntry<T> | undefined;
    if (existing && existing.expiresAt > this.now()) return existing.value;

    const pending = this.inFlight.get(key) as Promise<T> | undefined;
    if (pending) return pending;

    const promise = fetcher()
      .then((value) => {
        this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
        this.notify();
        return value;
      })
      .catch((error) => {
        if (existing) return existing.value;
        throw error;
      })
      .finally(() => {
        if (this.inFlight.get(key) === promise) {
          this.inFlight.delete(key);
        }
      });
    this.inFlight.set(key, promise);
    return promise;
  }

  private peek<T>(key: string): T | null {
    return (this.entries.get(key)?.value as T | undefined) ?? null;
  }

  private resolveCatalog(catalog?: string | null): string {
    return normalize(catalog ?? this.defaultCatalog);
  }

  private key(kind: CacheKind, ...parts: string[]): string {
    return [this.sessionId, kind, ...parts].join("|");
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener());
  }
}

export function createDbMetadataCache(options: DbMetadataCacheOptions): DbMetadataCache {
  return new DbMetadataCache(options);
}
