/** Keep change kinds consistent across Changes (tree/flat) and commit files. */
export function gitChangeStatusColor(status: string, conflict = false): string {
  if (conflict) return "bg-red-500/15 text-red-500";
  switch (status) {
    case "added":
      return "bg-emerald-500/15 text-emerald-500";
    case "deleted":
      return "bg-red-500/15 text-red-500";
    case "renamed":
    case "copied":
      return "bg-purple-500/15 text-purple-500";
    case "untracked":
      return "bg-amber-500/15 text-amber-500";
    default:
      return "bg-blue-500/15 text-blue-500";
  }
}
