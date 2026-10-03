/** Wait for a business condition, with cancellation and a bounded preparation deadline. */
export async function waitShellReady<T>(read: () => T | null | undefined | false, signal?: AbortSignal, timeout = 10000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (!signal?.aborted && Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(signal?.aborted ? "Operation cancelled" : "The destination did not become ready. The original view is preserved; retry after correcting the error.");
}
export function visibleShellNode(selector: string): HTMLElement | null {
  const nodes = document.querySelectorAll<HTMLElement>(selector);
  return [...nodes].find((node) => {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && !node.closest('[inert],[aria-hidden="true"]');
  }) ?? null;
}
