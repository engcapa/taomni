const PROMPT_MARKERS = ["$ ", "# ", "> ", "% "];

/**
 * Extract the command displayed after a common shell prompt terminator.
 *
 * Search the untrimmed text so an idle prompt keeps the space that is part of
 * its terminator. Prefer the first marker: prompt-like text typed later in the
 * command must never make an active input line look idle to callers that may
 * inject terminal input.
 */
export function extractTerminalCommand(text: string): string {
  let promptEnd = -1;

  for (const marker of PROMPT_MARKERS) {
    const index = text.indexOf(marker);
    if (index >= 0 && (promptEnd < 0 || index < promptEnd)) {
      promptEnd = index + marker.length;
    }
  }

  return (promptEnd >= 0 ? text.slice(promptEnd) : text).trim();
}
