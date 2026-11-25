/** Keep change kinds consistent across Changes (tree/flat) and commit files. */
export function gitChangeStatusColor(status: string, conflict = false): string {
  if (conflict) return "bg-ui-danger-surface text-ui-danger";
  switch (status) {
    case "added":
      return "bg-ui-success-surface text-ui-success";
    case "deleted":
      return "bg-ui-danger-surface text-ui-danger";
    case "renamed":
    case "copied":
      return "bg-[var(--taomni-git-moved-bg)] text-[var(--taomni-git-moved-text)]";
    case "untracked":
      return "bg-ui-warning-surface text-ui-warning";
    default:
      return "bg-ui-info-surface text-ui-info";
  }
}
