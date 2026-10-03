// Browser-preview model of the mail filter engine (src-tauri/src/mail/filters.rs).
// It evaluates header conditions against the stub cache and applies actions
// through the stub server model, so QA cases can drive the filter UI. It
// proves renderer orchestration only; the Rust tests cover the real engine.

import type { MailFilter, MailFilterCondition, MailFilterRunResult } from "../lib/mailFilters";
import {
  stubMailCachedHeaders,
  stubMailTransfer,
  stubMailUpdateCachedFlags,
  type Seed,
} from "./mailServerStub";

const filtersByAccount = new Map<string, MailFilter[]>();
const marks = new Map<string, number>();

function markKey(accountId: string, folder: string) {
  return `${accountId}\u0000${folder}`;
}

function maxUid(accountId: string, seed: Seed, folder: string) {
  return Math.max(0, ...stubMailCachedHeaders(accountId, seed, folder).map((message) => message.uid));
}

export function stubListFilters(accountId: string): MailFilter[] {
  return (filtersByAccount.get(accountId) ?? []).map((filter) => ({ ...filter }));
}

export function stubSaveFilters(accountId: string, seed: Seed, filters: MailFilter[]): MailFilter[] {
  for (const filter of filters) {
    if (!filter.name.trim()) throw new Error("every filter needs a name");
    if (!filter.conditions.length || !filter.actions.length) {
      throw new Error(`${filter.name}: add at least one condition and action`);
    }
  }
  filtersByAccount.set(accountId, filters.map((filter) => ({ ...filter, name: filter.name.trim() })));
  const key = markKey(accountId, "INBOX");
  if (!marks.has(key)) marks.set(key, maxUid(accountId, seed, "INBOX"));
  return stubListFilters(accountId);
}

function text(op: MailFilterCondition["op"], haystack: string, needle: string) {
  const hay = haystack.toLowerCase();
  const value = needle.toLowerCase().trim();
  switch (op) {
    case "contains": return hay.includes(value);
    case "notContains": return !hay.includes(value);
    case "is": return hay.trim() === value;
    case "isNot": return hay.trim() !== value;
    case "beginsWith": return hay.trim().startsWith(value);
    case "endsWith": return hay.trim().endsWith(value);
    case "matches":
      try {
        return new RegExp(needle, "i").test(haystack);
      } catch {
        return false;
      }
    default: return false;
  }
}

type Header = ReturnType<typeof stubMailCachedHeaders>[number];

function matches(condition: MailFilterCondition, message: Header) {
  const addresses = (list: { name: string; address: string }[]) =>
    condition.op === "is" || condition.op === "isNot" || condition.op === "beginsWith" || condition.op === "endsWith"
      ? (condition.op === "isNot"
        ? !list.some((a) => text("is", a.address, condition.value) || text("is", a.name, condition.value))
        : list.some((a) => text(condition.op, a.address, condition.value) || text(condition.op, a.name, condition.value)))
      : text(condition.op, list.map((a) => `${a.name} <${a.address}>`).join(", "), condition.value);
  switch (condition.field) {
    case "from": return addresses([message.from]);
    case "to": return addresses(message.to);
    case "cc": return addresses(message.cc);
    case "toOrCc": return addresses([...message.to, ...message.cc]);
    case "subject": return text(condition.op, message.subject, condition.value);
    case "body": return text(condition.op, message.snippet, condition.value);
    case "tag": return message.flags.includes(condition.value) === (condition.op === "is");
    case "hasAttachment": return (message.attachmentCount > 0) === (condition.op === "is");
    default: return false;
  }
}

export function stubApplyFilters(
  accountId: string,
  seed: Seed,
  folder: string,
  trigger: string,
  options: { uids?: number[] | null; filterIds?: string[] | null; trashFolder?: string | null },
): MailFilterRunResult {
  const result: MailFilterRunResult = { folder, examined: 0, matched: 0, moved: 0, errors: [] };
  const incoming = trigger === "incoming";
  const filters = (filtersByAccount.get(accountId) ?? [])
    .filter((filter) => filter.enabled && (!incoming || filter.onIncoming))
    .filter((filter) => !options.filterIds || options.filterIds.includes(filter.id));
  const key = markKey(accountId, folder);
  const cached = stubMailCachedHeaders(accountId, seed, folder).sort((a, b) => a.uid - b.uid);
  let candidates = cached;
  if (incoming) {
    const mark = marks.get(key);
    if (mark === undefined) {
      marks.set(key, maxUid(accountId, seed, folder));
      return result;
    }
    candidates = cached.filter((message) => message.uid > mark);
    if (candidates.length) marks.set(key, Math.max(...candidates.map((message) => message.uid)));
  } else if (options.uids) {
    candidates = cached.filter((message) => options.uids!.includes(message.uid));
  }
  result.examined = candidates.length;
  for (const message of candidates) {
    let hit = false;
    let done = false;
    for (const filter of filters) {
      if (done) break;
      const ok = filter.matchAny
        ? filter.conditions.some((condition) => matches(condition, message))
        : filter.conditions.every((condition) => matches(condition, message));
      if (!ok) continue;
      hit = true;
      for (const action of filter.actions) {
        const value = action.value?.trim() ?? "";
        if (action.kind === "markRead") stubMailUpdateCachedFlags(accountId, folder, [message.uid], ["\\Seen"], []);
        else if (action.kind === "markUnread") stubMailUpdateCachedFlags(accountId, folder, [message.uid], [], ["\\Seen"]);
        else if (action.kind === "star") stubMailUpdateCachedFlags(accountId, folder, [message.uid], ["\\Flagged"], []);
        else if (action.kind === "addTag" && value) stubMailUpdateCachedFlags(accountId, folder, [message.uid], [value], []);
        else if (action.kind === "copyTo" && value) stubMailTransfer(accountId, seed, folder, [message.uid], value, true);
        else if (action.kind === "forward") result.errors.push("forward: not available in the browser preview");
        else if ((action.kind === "moveTo" && value && value !== folder) || action.kind === "delete") {
          const target = action.kind === "delete" ? options.trashFolder ?? null : value;
          result.moved += stubMailTransfer(accountId, seed, folder, [message.uid], target, false);
          done = true;
          break;
        } else if (action.kind === "stop") {
          done = true;
          break;
        }
      }
    }
    if (hit) result.matched += 1;
  }
  return result;
}
