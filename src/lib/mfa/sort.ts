import { MFA_UNGROUPED, type MfaAccount, type MfaSortMode } from "./types";

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

function byText(a: string, b: string): number {
  // Empty values sort last so unnamed accounts do not crowd the top.
  if (!a && b) return 1;
  if (a && !b) return -1;
  return collator.compare(a, b);
}

function byCustom(a: MfaAccount, b: MfaAccount): number {
  return a.sortOrder - b.sortOrder || a.createdAt - b.createdAt || a.id.localeCompare(b.id);
}

const COMPARATORS: Record<MfaSortMode, (a: MfaAccount, b: MfaAccount) => number> = {
  custom: byCustom,
  issuer: (a, b) => byText(a.issuer, b.issuer) || byText(a.accountName, b.accountName) || byCustom(a, b),
  account: (a, b) => byText(a.accountName, b.accountName) || byText(a.issuer, b.issuer) || byCustom(a, b),
  recent: (a, b) => (b.lastUsedAt ?? -1) - (a.lastUsedAt ?? -1) || byCustom(a, b),
  frequent: (a, b) => b.useCount - a.useCount || (b.lastUsedAt ?? -1) - (a.lastUsedAt ?? -1) || byCustom(a, b),
  added: (a, b) => b.createdAt - a.createdAt || byCustom(a, b),
};

/** Pinned accounts first, then the selected order. Returns a new array. */
export function sortAccounts(accounts: MfaAccount[], mode: MfaSortMode): MfaAccount[] {
  const compare = COMPARATORS[mode] ?? byCustom;
  return [...accounts].sort((a, b) => Number(b.pinned) - Number(a.pinned) || compare(a, b));
}

export function matchesQuery(account: MfaAccount, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [account.issuer, account.accountName, account.group, account.note].some((field) =>
    field.toLocaleLowerCase().includes(needle),
  );
}

export function matchesGroup(account: MfaAccount, group: string): boolean {
  if (!group) return true;
  if (group === MFA_UNGROUPED) return !account.group;
  return account.group === group;
}

export function visibleAccounts(
  accounts: MfaAccount[],
  options: { query: string; group: string; sortMode: MfaSortMode },
): MfaAccount[] {
  return sortAccounts(
    accounts.filter((account) => matchesGroup(account, options.group) && matchesQuery(account, options.query)),
    options.sortMode,
  );
}

/** Distinct non-empty groups in display order. */
export function accountGroups(accounts: MfaAccount[]): string[] {
  return [...new Set(accounts.map((account) => account.group).filter(Boolean))].sort(collator.compare);
}

/**
 * New full custom order after moving `movingId` to `targetId`'s slot. Works on
 * the global custom order so a filtered view still reorders consistently.
 */
export function moveInCustomOrder(accounts: MfaAccount[], movingId: string, targetId: string): string[] {
  const ordered = [...accounts].sort(byCustom).map((account) => account.id);
  const from = ordered.indexOf(movingId);
  const to = ordered.indexOf(targetId);
  if (from < 0 || to < 0 || from === to) return ordered;
  ordered.splice(from, 1);
  ordered.splice(to, 0, movingId);
  return ordered;
}
