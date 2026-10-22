import { type GitChange } from "../../../lib/git";
import { type TranslateFn } from "../../../lib/i18n";
import type { GitWorkspaceRootInfo } from "../../../types";

export function repoAbbr(name: string): string {
  const words = name
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length >= 2) return words.slice(0, 2).map((word) => word[0]).join("").toUpperCase();
  const compact = (words[0] ?? name).replace(/[^a-zA-Z0-9]/g, "");
  return (compact.slice(0, 3) || "repo").toUpperCase();
}

export function workspaceStatusMeta(change: GitChange, t: TranslateFn): {
  kindLabel: string;
  kindClass: string;
  statusLabel: string;
} {
  if (change.conflict) {
    return {
      kindLabel: "!",
      kindClass: "bg-red-500/15 text-red-500",
      statusLabel: t("git.workspaceChanges.statusConflict"),
    };
  }
  if (change.staged) {
    return {
      kindLabel: shortChangeKind(change),
      kindClass: "bg-emerald-500/15 text-emerald-600",
      statusLabel: t("git.workspaceChanges.statusStaged"),
    };
  }
  if (change.status === "untracked") {
    return {
      kindLabel: "?",
      kindClass: "bg-amber-500/15 text-amber-600",
      statusLabel: t("git.workspaceChanges.statusUntracked"),
    };
  }
  return {
    kindLabel: shortChangeKind(change),
    kindClass: "bg-blue-500/15 text-blue-500",
    statusLabel: statusLabelForChange(change, t),
  };
}

export function statusLabelForChange(change: GitChange, t: TranslateFn): string {
  if (change.status === "renamed") return t("git.workspaceChanges.statusRenamed");
  if (change.status === "deleted") return t("git.workspaceChanges.statusDeleted");
  if (change.status === "added") return t("git.workspaceChanges.statusAdded");
  return t("git.workspaceChanges.statusModified");
}

export function shortChangeKind(change: GitChange): string {
  if (change.status === "renamed") return "R";
  if (change.status === "deleted") return "D";
  if (change.status === "added") return "A";
  if (change.status === "untracked") return "?";
  return "M";
}

export function repoColorFor(repoRoot: string): { bg: string; border: string; text: string; } {
  const palette = [
    { bg: "#DBEAFE", border: "#2563EB", text: "#1D4ED8" },
    { bg: "#DCFCE7", border: "#16A34A", text: "#15803D" },
    { bg: "#FEF3C7", border: "#D97706", text: "#B45309" },
    { bg: "#FCE7F3", border: "#DB2777", text: "#BE185D" },
    { bg: "#E0F2FE", border: "#0284C7", text: "#0369A1" },
    { bg: "#EDE9FE", border: "#7C3AED", text: "#6D28D9" },
    { bg: "#CCFBF1", border: "#0D9488", text: "#0F766E" },
    { bg: "#FFE4E6", border: "#E11D48", text: "#BE123C" },
  ];
  let hash = 0;
  for (let i = 0; i < repoRoot.length; i += 1) {
    hash = (hash * 31 + repoRoot.charCodeAt(i)) >>> 0;
  }
  return palette[hash % palette.length];
}

export function workspaceChangeMatchesSearch(
  root: GitWorkspaceRootInfo,
  change: GitChange,
  normalizedFilter: string,
): boolean {
  if (!normalizedFilter) return true;
  return (
    root.name.toLowerCase().includes(normalizedFilter) ||
    root.repoRoot.toLowerCase().includes(normalizedFilter) ||
    change.path.toLowerCase().includes(normalizedFilter) ||
    (change.oldPath ?? "").toLowerCase().includes(normalizedFilter) ||
    change.status.toLowerCase().includes(normalizedFilter) ||
    (change.conflict ? "conflict conflicted" : "").includes(normalizedFilter) ||
    (change.staged ? "staged" : "").includes(normalizedFilter) ||
    (change.unstaged ? "unstaged" : "").includes(normalizedFilter)
  );
}
