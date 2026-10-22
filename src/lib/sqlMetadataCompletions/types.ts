import { type DbMetadataCache } from "../dbMetadataCache";

export interface TableRef {
  catalog: string | null;
  schema: string | null;
  table: string;
}

export interface NamedTableRef {
  ref: TableRef;
  qualifier: string;
}

export interface SqlMetadataCompletionOptions {
  cache: DbMetadataCache;
  engine: string;
  activeSchema?: string | null;
  catalog?: string | null;
  maxOptions?: number;
  onError?: (message: string) => void;
  onLoadingChange?: (loading: boolean) => void;
  onResult?: (result: { count: number; limitReached: boolean; }) => void;
}

export interface SqlMetadataNamespaceOptions {
  cache: DbMetadataCache;
  engine: string;
  activeSchema?: string | null;
  catalog?: string | null;
}

export interface CompletionPrefix {
  from: number;
  text: string;
  quoted: boolean;
}

export interface SelectColumn {
  name: string;
  type?: string;
  primaryKey?: boolean;
}

export interface SelectColumnSource {
  qualifier: string;
  detail: string;
  columns: SelectColumn[];
}
