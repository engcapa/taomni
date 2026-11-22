export function isRootRequiredError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("cap_net_admin") ||
    lower.includes("linux capture requires") ||
    lower.includes("linux capture needs root") ||
    lower.includes("linux cgroup cleanup requires") ||
    lower.includes("permission to manage cgroup v2")
  );
}

export function isSudoAuthenticationError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("incorrect password") ||
    lower.includes("authentication failure") ||
    lower.includes("sudo authentication failed") ||
    lower.includes("sorry, try again") ||
    lower.includes("a password is required")
  );
}
