/** Compare native canonical Windows paths with workspace display paths.
 * Identity only: never changes the actual path passed to native filesystem APIs.
 * POSIX paths remain case-sensitive; no guessed symlink resolution occurs here.
 */
export function agentProjectKey(path: string): string {
  let value = path;
  const windows = /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\") || value.startsWith("//?/") || value.startsWith("//");
  if (windows) {
    value = value.replace(/\\/g, "/");
    if (value.startsWith("//?/")) {
      value = value.slice(4);
      if (/^UNC\//i.test(value)) value = "//" + value.slice(4);
    }
    return value.replace(/\/+$/, "").toLowerCase();
  }
  return value === "/" ? value : value.replace(/\/+$/, "");
}
export const sameAgentProject = (left: string, right: string): boolean => agentProjectKey(left) === agentProjectKey(right);
