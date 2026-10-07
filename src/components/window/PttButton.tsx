import { DictationButton } from "../voice/DictationButton";
import { useAppStore } from "../../stores/appStore";
import { useChatStore } from "../../stores/chatStore";

/** Title-bar entry stages ordinary draft text; it never sends a message. */
export function PttButton() {
  const workspace = useAppStore((s) => s.activeTabId);
  const thread = useChatStore((s) => s.activeThreadId);
  const tab = useChatStore((s) => s.drawerTabId);
  return <DictationButton testId="ptt-button" contextKey={`${workspace}:${tab}:${thread}`} onTranscript={(text) => {
    const pending = useChatStore.getState().pendingComposerText;
    useChatStore.setState({ drawerOpen: true, pendingComposerText: pending ? `${pending}\n${text}` : text });
  }} />;
}
