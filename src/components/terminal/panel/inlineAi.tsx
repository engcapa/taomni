import { Terminal } from "@xterm/xterm";
import { VAULT_LOCKED_EVENT, isVaultLockedError } from "../../../lib/ipc";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";


// AI inline `??` rendering: stream LLM tokens directly into the terminal as
// gray-styled ANSI text. The rendering is purely visual (xterm.write); it
// never reaches the underlying PTY, so a real `cat`/`grep`/`vim` can run on
// the next prompt without any ghost characters left behind. Each request
// uses a fresh `inline-qq:<request_id>` event channel so concurrent calls
// from different tabs do not cross-contaminate.
export async function streamInlineAi(term: Terminal, question: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  const requestId = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const event = `inline-qq:${requestId}`;

  // ANSI: dim gray foreground, bold prefix.
  const PREFIX = "\\x1b[38;5;244m\\x1b[1m[AI]\\x1b[0m\\x1b[38;5;244m ";
  const SUFFIX = "\\x1b[0m";

  // Header line so the user sees the question echoed back.
  term.write(`\\r\\n\\x1b[38;5;244m?? ${question}\\x1b[0m\\r\\n`);
  term.write(PREFIX);

  let unlisten: UnlistenFn | null = null;
  try {
    unlisten = await listen<{ kind: string; content?: string; message?: string }>(event, (e) => {
      const payload = e.payload;
      if (payload.kind === "token" && payload.content) {
        term.write(payload.content.replace(/\\n/g, "\\r\\n" + PREFIX));
      } else if (payload.kind === "error") {
        if (isVaultLockedError(payload.message ?? "")) {
          window.dispatchEvent(
            new CustomEvent(VAULT_LOCKED_EVENT, {
              detail: {
                reason:
                  "This AI provider's API key is in the credential vault — unlock it to continue.",
              },
            }),
          );
        }
        term.write(`${SUFFIX}\\r\\n\\x1b[31m[AI error] ${payload.message ?? "unknown"}${SUFFIX}\\r\\n`);
      } else if (payload.kind === "end") {
        term.write(`${SUFFIX}\\r\\n`);
      }
    });
    await invoke("inline_qq_stream", { requestId, question });
  } catch (e) {
    if (isVaultLockedError(e)) {
      window.dispatchEvent(
        new CustomEvent(VAULT_LOCKED_EVENT, {
          detail: {
            reason:
              "This AI provider's API key is in the credential vault — unlock it to continue.",
          },
        }),
      );
    }
    term.write(`${SUFFIX}\\r\\n\\x1b[31m[AI error] ${String(e)}${SUFFIX}\\r\\n`);
  } finally {
    if (unlisten) unlisten();
  }
}
