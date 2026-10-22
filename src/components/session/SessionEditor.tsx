import { getShortcutSuffixes } from "../../hooks/useModalShortcuts";
import type { SessionConfig } from "../../lib/ipc";
import { SessionEditorView } from "./editor/SessionEditorView";
import { useSessionEditorActions } from "./editor/useSessionEditorActions";
import { useSessionEditorNavigation } from "./editor/useSessionEditorNavigation";
import { useSessionEditorState } from "./editor/useSessionEditorState";

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */
interface SessionEditorProps {
  session?: SessionConfig;
  defaultGroupPath?: string | null;
  /**
   * Pre-select the protocol when creating a *new* session (no `session`
   * prop). Accepts a session-type string (e.g. `"SFTP"`, `"SSH"`); falls
   * back to SSH if unrecognized. Ignored when editing an existing session.
   */
  initialProto?: string;
  onClose: () => void;
}

export function SessionEditor({ session, defaultGroupPath = null, initialProto, onClose }: SessionEditorProps) {
  const form = useSessionEditorState({
    session,
    initialProto,
    defaultGroupPath,
  });
  const actions = useSessionEditorActions({
    form,
    session,
    onClose,
    defaultGroupPath,
  });
  const navigation = useSessionEditorNavigation({
    form,
    actions,
    onClose,
  });

  const shortcuts = getShortcutSuffixes();

  return <SessionEditorView
    navigation={navigation}
    form={form}
    onClose={onClose}
    actions={actions}
    session={session}
    shortcuts={shortcuts}
  />;
}
