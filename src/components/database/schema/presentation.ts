import { BookText, Boxes, Braces, CalendarClock, Eye, ListOrdered, SquareFunction, Table2, Zap } from "lucide-react";
import { type ObjectKind } from "../../../lib/sqlDialect";

export const CATEGORY_META: Record<
  ObjectKind,
  { label: string; Icon: typeof Table2; color: string; }
> = {
  table: { label: "Tables", Icon: Table2, color: "#3b7ac2" },
  view: { label: "Views", Icon: Eye, color: "#c97a23" },
  materialized_view: { label: "Materialized Views", Icon: Boxes, color: "#c97a23" },
  procedure: { label: "Procedures", Icon: Braces, color: "#8a63d2" },
  function: { label: "Functions", Icon: SquareFunction, color: "#8a63d2" },
  trigger: { label: "Triggers", Icon: Zap, color: "#d9a13b" },
  event: { label: "Events", Icon: CalendarClock, color: "#4aa564" },
  sequence: { label: "Sequences", Icon: ListOrdered, color: "#4aa564" },
  dictionary: { label: "Dictionaries", Icon: BookText, color: "#4aa564" },
};

/** Categories whose objects come from `db_list_tables` (split by `kind`). */
export const TABLE_CATEGORIES: ObjectKind[] = ["table", "view", "materialized_view"];

/** Categories whose objects can expand to show their columns. */
export const COLUMN_CATEGORIES: ObjectKind[] = ["table", "view", "materialized_view"];

export const SELECTABLE_OBJECT_KINDS = new Set<ObjectKind>(TABLE_CATEGORIES);

export const dbKey = (db: string) => db;

export const catKey = (db: string, kind: ObjectKind) => `${db}::${kind}`;

export const objKey = (db: string, kind: ObjectKind, name: string) => `${db}::${kind}::${name}`;

export function formatRowCount(count: number): string {
  if (count >= 1_000_000_000) return `${(count / 1_000_000_000).toFixed(1)}B`;
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}
