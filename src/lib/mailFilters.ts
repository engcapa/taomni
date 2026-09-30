import { invoke } from "@tauri-apps/api/core";
import type { MailTabInfo } from "../types";
import { withVaultLockedNotice } from "./ipc";
import type { MailMessageHeader } from "./mail";

/** Message filters (TASK-13, DEC-11); mirrors src-tauri/src/mail/filters.rs. */
export type MailFilterField =
  | "from"
  | "to"
  | "cc"
  | "toOrCc"
  | "subject"
  | "body"
  | "sizeKb"
  | "ageDays"
  | "tag"
  | "hasAttachment";

export type MailFilterOp =
  | "contains"
  | "notContains"
  | "is"
  | "isNot"
  | "beginsWith"
  | "endsWith"
  | "matches"
  | "greaterThan"
  | "lessThan";

export type MailFilterActionKind =
  | "moveTo"
  | "copyTo"
  | "markRead"
  | "markUnread"
  | "star"
  | "addTag"
  | "delete"
  | "forward"
  | "stop";

export interface MailFilterCondition {
  field: MailFilterField;
  op: MailFilterOp;
  value: string;
}

export interface MailFilterAction {
  kind: MailFilterActionKind;
  value?: string | null;
}

export interface MailFilter {
  id: string;
  name: string;
  enabled: boolean;
  matchAny: boolean;
  conditions: MailFilterCondition[];
  actions: MailFilterAction[];
  onIncoming: boolean;
}

export interface MailFilterRunResult {
  folder: string;
  examined: number;
  matched: number;
  moved: number;
  errors: string[];
}

export const MAIL_FILTER_FIELDS: { value: MailFilterField; label: string }[] = [
  { value: "from", label: "From" },
  { value: "to", label: "To" },
  { value: "cc", label: "Cc" },
  { value: "toOrCc", label: "To or Cc" },
  { value: "subject", label: "Subject" },
  { value: "body", label: "Body" },
  { value: "sizeKb", label: "Size (KB)" },
  { value: "ageDays", label: "Age (days)" },
  { value: "tag", label: "Tag" },
  { value: "hasAttachment", label: "Has attachment" },
];

const OP_LABELS: Record<MailFilterOp, string> = {
  contains: "contains",
  notContains: "doesn't contain",
  is: "is",
  isNot: "isn't",
  beginsWith: "begins with",
  endsWith: "ends with",
  matches: "matches regex",
  greaterThan: "is greater than",
  lessThan: "is less than",
};

/** Operators each field supports (body: only what server SEARCH can answer). */
export function filterOpsFor(field: MailFilterField): { value: MailFilterOp; label: string }[] {
  let ops: MailFilterOp[];
  switch (field) {
    case "sizeKb":
    case "ageDays":
      ops = ["greaterThan", "lessThan"];
      break;
    case "body":
      ops = ["contains", "notContains"];
      break;
    case "tag":
    case "hasAttachment":
      ops = ["is", "isNot"];
      break;
    default:
      ops = ["contains", "notContains", "is", "isNot", "beginsWith", "endsWith", "matches"];
  }
  return ops.map((value) => ({ value, label: OP_LABELS[value] }));
}

export const MAIL_FILTER_ACTIONS: { value: MailFilterActionKind; label: string; needs?: "folder" | "tag" | "address" }[] = [
  { value: "moveTo", label: "Move to folder", needs: "folder" },
  { value: "copyTo", label: "Copy to folder", needs: "folder" },
  { value: "markRead", label: "Mark as read" },
  { value: "markUnread", label: "Mark as unread" },
  { value: "star", label: "Star" },
  { value: "addTag", label: "Add tag", needs: "tag" },
  { value: "delete", label: "Delete (move to Trash)" },
  { value: "forward", label: "Forward to", needs: "address" },
  { value: "stop", label: "Stop filter execution" },
];

export function actionNeeds(kind: MailFilterActionKind): "folder" | "tag" | "address" | undefined {
  return MAIL_FILTER_ACTIONS.find((entry) => entry.value === kind)?.needs;
}

function newFilterId(): string {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `filter-${random}`;
}

export function newMailFilter(partial: Partial<MailFilter> = {}): MailFilter {
  return {
    id: newFilterId(),
    name: "",
    enabled: true,
    matchAny: false,
    conditions: [{ field: "from", op: "contains", value: "" }],
    actions: [{ kind: "moveTo", value: "" }],
    onIncoming: true,
    ...partial,
  };
}

/** "Create filter from message": pre-fill the sender (Thunderbird behavior). */
export function filterFromMessage(message: Pick<MailMessageHeader, "from" | "subject">): MailFilter {
  const address = message.from?.address?.trim() ?? "";
  const who = message.from?.name?.trim() || address;
  return newMailFilter({
    name: who ? `From ${who}` : "New filter",
    conditions: [{ field: "from", op: address ? "is" : "contains", value: address }],
  });
}

/** First problem that would make the backend reject the filter, if any. */
export function filterProblem(filter: MailFilter): string | null {
  if (!filter.name.trim()) return "Give the filter a name";
  if (filter.conditions.length === 0) return "Add at least one condition";
  if (filter.actions.length === 0) return "Add at least one action";
  for (const condition of filter.conditions) {
    if (condition.field === "sizeKb" || condition.field === "ageDays") {
      if (!condition.value.trim() || Number.isNaN(Number(condition.value))) return "Size and age need a number";
    } else if (condition.field !== "hasAttachment" && !condition.value.trim()) {
      return "Every condition needs a value";
    }
    if (condition.op === "matches") {
      try {
        new RegExp(condition.value);
      } catch {
        return `Invalid regular expression: ${condition.value}`;
      }
    }
  }
  for (const action of filter.actions) {
    const needs = actionNeeds(action.kind);
    const value = (action.value ?? "").trim();
    if (needs && !value) return "An action needs a folder, tag or address";
    if (needs === "address" && !value.includes("@")) return "Forward needs an email address";
  }
  return null;
}

/** One-line summary for the rule list. */
export function describeFilter(filter: MailFilter): string {
  const field = (value: MailFilterField) => MAIL_FILTER_FIELDS.find((entry) => entry.value === value)?.label ?? value;
  const conditions = filter.conditions
    .map((c) => (c.field === "hasAttachment" ? `${OP_LABELS[c.op]} with attachment` : `${field(c.field)} ${OP_LABELS[c.op]} "${c.value}"`))
    .join(filter.matchAny ? " or " : " and ");
  const actions = filter.actions
    .map((a) => {
      const label = MAIL_FILTER_ACTIONS.find((entry) => entry.value === a.kind)?.label ?? a.kind;
      return a.value ? `${label} ${a.value}` : label;
    })
    .join(", ");
  return `${conditions} → ${actions}`;
}

export function mailListFilters(accountId: string): Promise<MailFilter[]> {
  return invoke<MailFilter[]>("mail_list_filters", { accountId });
}

export function mailSaveFilters(accountId: string, filters: MailFilter[]): Promise<MailFilter[]> {
  return invoke<MailFilter[]>("mail_save_filters", { accountId, filters });
}

export function mailApplyFilters(
  config: MailTabInfo,
  folder: string,
  trigger: "incoming" | "manual",
  options: { uids?: number[]; filterIds?: string[]; trashFolder?: string | null } = {},
): Promise<MailFilterRunResult> {
  return withVaultLockedNotice(() =>
    invoke<MailFilterRunResult>("mail_apply_filters", {
      config,
      folder,
      trigger,
      uids: options.uids ?? null,
      filterIds: options.filterIds ?? null,
      trashFolder: options.trashFolder ?? null,
    }),
  );
}

export function mailExportFilters(accountId: string, targetPath: string): Promise<number> {
  return invoke<number>("mail_export_filters", { accountId, targetPath });
}

export function mailImportFilters(accountId: string, sourcePath: string): Promise<MailFilter[]> {
  return invoke<MailFilter[]>("mail_import_filters", { accountId, sourcePath });
}
