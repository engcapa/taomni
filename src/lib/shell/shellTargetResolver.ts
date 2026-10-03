import { useAppStore } from "../../stores/appStore";
import { useShellLayoutStore } from "../../stores/shellLayoutStore";
import { useChatStore } from "../../stores/chatStore";
import { useNotesStore } from "../../stores/notesStore";
import { useTaoHubStore } from "../../stores/taoHubStore";
import { useTransferStore } from "../../stores/transferStore";
import { useAiStore } from "../../stores/aiStore";
import type { TaoAlert } from "../tao/taoAlerts";
import type { RevealResult, ShellTarget } from "./types";
import { waitShellReady } from "./readiness";
import { getPanelActions } from "./panelActions";
import { getNote } from "../notes";

let openMailAccount: ((id: string) => void | Promise<void>) | undefined;
export function installShellTargetOpeners(openers: { mailAccount(id: string): void | Promise<void> }) {
  openMailAccount = openers.mailAccount;
  return () => { if (openMailAccount === openers.mailAccount) openMailAccount = undefined; };
}
async function waitVisible(selector: string, signal: AbortSignal) {
  const deadline = Date.now() + 5000;
  while (!signal.aborted && Date.now() < deadline) {
    const node = document.querySelector<HTMLElement>(selector);
    if (node && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0 && !node.closest('[inert],[aria-hidden="true"]')) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  if (signal.aborted) throw new Error("Navigation was cancelled");
  throw new Error("The target has not become visible. Retry after it finishes opening.");
}

export function targetForAlert(alert: TaoAlert): ShellTarget | null {
  if (alert.source === "chat" && alert.threadId) return { kind: "chat", threadId: alert.threadId };
  if (alert.source === "notes" && alert.noteId) return { kind: "note", noteId: alert.noteId };
  if (alert.source === "mail" && alert.mailAccountId) return { kind: "mail", accountId: alert.mailAccountId };
  if (alert.source === "transfer" && alert.jobId) return { kind: "transfer", jobId: alert.jobId, panelId: alert.panelId };
  return null;
}
export async function revealShellTarget(target: ShellTarget, signal = new AbortController().signal): Promise<RevealResult> {
  const missing = (message: string): RevealResult => ({ status: "failed", code: "missing", message });
  const revealTab = (id: string | undefined) => {
    if (!id || !useAppStore.getState().tabs.some((tab) => tab.id === id)) return false;
    useAppStore.getState().setActiveTab(id); useShellLayoutStore.getState().visitTab(id); return true;
  };
  try {
    if (signal.aborted) return { status: "cancelled" };
    let targetKey: string;
    switch (target.kind) {
      case "tab":
        if (!revealTab(target.tabId)) return missing("This tab is closed. Reopen its connection or workspace.");
        targetKey = `tab:${target.tabId}`; break;
      case "panel": {
        const shell = useShellLayoutStore.getState();
        const panel = target.panelId ? shell.panels[target.panelId] : Object.values(shell.panels).find((p) => p.kind === target.panelKind && p.owner.kind === target.owner.kind && p.owner.kind !== "background" && target.owner.kind !== "background" && p.owner.tabId === target.owner.tabId);
        if (!panel || panel.phase === "failed") return missing("The panel is unavailable. Reopen its owner.");
        if (panel.owner.kind !== "background" && !revealTab(panel.owner.tabId)) return missing("The panel owner is unavailable.");
        shell.openPanel(panel.id); targetKey = panel.id; break;
      }
      case "chat": {
        if (useAiStore.getState().config?.fully_disabled) return missing("AI is disabled. Enable it in settings to open this conversation.");
        const chat = useChatStore.getState();
        if (!chat.threads.some((thread) => thread.id === target.threadId)) await chat.loadThreads();
        if (signal.aborted) return { status: "cancelled" };
        const thread = useChatStore.getState().threads.find((t) => t.id === target.threadId);
        if (!thread) return missing("This conversation is unavailable.");
        const tab = useAppStore.getState().tabs.find((tab) => tab.id === thread.linked_session_id || tab.chatTabId === thread.linked_session_id);
        if (tab) revealTab(tab.id);
        useChatStore.getState().setActiveThread(thread.id);
        if (!(await useChatStore.getState().loadMessages(thread.id))) throw new Error("Conversation messages could not be loaded. Retry this notification.");
        if (signal.aborted) return { status: "cancelled" };
        useTaoHubStore.getState().setHubTab("chat"); useChatStore.getState().setDrawerOpen(true);
        await waitVisible(`[data-testid="shell-chat-content"][data-thread-id="${CSS.escape(thread.id)}"][data-ready="true"]`, signal);
        targetKey = `chat:${thread.id}`; break;
      }
      case "note": {
        const note = await getNote(target.noteId);
        if (signal.aborted) return { status: "cancelled" };
        if (!note) return missing("This note was removed or is unavailable.");
        useNotesStore.setState({ activeNoteSnapshot: note, activeNoteId: note.id });
        useNotesStore.getState().setPanelMode("hub");
        useTaoHubStore.getState().setHubTab("notes"); useChatStore.getState().setDrawerOpen(true);
        await waitVisible(`[data-testid="note-editor"][data-note-id="${CSS.escape(target.noteId)}"]`, signal);
        targetKey = `note:${target.noteId}`; break;
      }
      case "mail": {
        const findMail = () => useAppStore.getState().tabs.find((tab) => tab.type === "mail" && (tab.sessionId === target.accountId || tab.mail?.sessionId === target.accountId));
        if (!findMail()) await openMailAccount?.(target.accountId);
        const tab = findMail() ?? await waitShellReady(findMail, signal);
        if (!tab || !revealTab(tab.id)) return missing("Reopen the mail account to view this alert.");
        useShellLayoutStore.getState().setTaoOpen(false);
        await waitVisible(`[data-testid="mail-client-tab"][data-account-id="${CSS.escape(target.accountId)}"]`, signal);
        targetKey = `mail:${target.accountId}`; break;
      }
      case "transfer": {
        const job = useTransferStore.getState().byId(target.jobId);
        if (!job) return missing("This transfer is no longer available.");
        const shell = useShellLayoutStore.getState(), panel = target.panelId ? shell.panels[target.panelId] : Object.values(shell.panels).find((p) => p.kind === "sftp" && (`attached-${p.owner.kind !== "background" ? p.owner.tabId : ""}` === job.sessionId || (p.owner.kind === "background" && p.owner.resourceKey === `sftp:${job.sessionId}`)));
        if (!panel) {
          shell.revealTransfers(job.id);
          await waitVisible(`[data-testid="shell-transfers"] [data-job-id="${CSS.escape(job.id)}"]`, signal);
          targetKey = `transfer:${job.id}`;
          break;
        }
        if (panel.placement.kind === "detached") { await getPanelActions(panel.id)?.focus?.(); return missing("Inspect the transfer in its detached window; this alert remains available until the destination is confirmed."); }
        if (panel.placement.kind === "primary") revealTab(panel.placement.tabId);
        else if (panel.owner.kind !== "background") revealTab(panel.owner.tabId);
        shell.openPanel(panel.id);
        await waitVisible(`[data-surface-id="${CSS.escape(panel.id)}"]`, signal);
        const expand = document.querySelector<HTMLButtonElement>(`[data-surface-id="${CSS.escape(panel.id)}"] [data-testid="sftp-transfer-queue-expand-btn"]`);
        expand?.click();
        await waitVisible(`[data-surface-id="${CSS.escape(panel.id)}"] [data-testid="sftp-transfer-queue"]`, signal);
        targetKey = `transfer:${job.id}`; break;
      }
    }
    return { status: "revealed", targetKey };
  } catch (error) { return { status: "failed", code: "unavailable", message: String(error) }; }
}
